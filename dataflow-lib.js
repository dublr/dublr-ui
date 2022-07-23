
let DEBUG_DATAFLOW = false;

// From https://stackoverflow.com/a/9924463/3950982
var STRIP_COMMENTS = /((\/\/.*$)|(\/\*[\s\S]*?\*\/))/mg;
var ARGUMENT_NAMES = /([^\s,]+)/g;
function getParamNames(func) {
  var fnStr = func.toString().replace(STRIP_COMMENTS, '');
  var result = fnStr.slice(fnStr.indexOf('(')+1, fnStr.indexOf(')')).match(ARGUMENT_NAMES);
  if(result === null)
     result = [];
  return result;
}

function newQueue() {
    const queue = {
        headIdx: 0,
        tailIdx: 0,
        elts: {},
        enqueue: (elt) => queue.elts[queue.tailIdx++] = elt,
        dequeue: () => {
            if (queue.headIdx == queue.tailIdx) {
                throw new Error("Queue is empty");
            }
            return queue.elts[queue.headIdx++];
        },
        size: () => queue.tailIdx - queue.headIdx,
        isEmpty: () => queue.tailIdx == queue.headIdx
    };
    return queue;
}

const dataflow = {
    nameToFn: new Map(),               // name -> function
    nodeToUpstreamNodes: new Map(),    // name -> list of names
    nodeToDownstreamNodes: new Map(),  // name -> list of names
    updateBatches: newQueue(),         // queue of {name: value} objects
    value: {},                         // name -> value (as Object) -- read this for cached values
    inProgress: false,
    
    register: function(...fns) {
        for (const fn of fns) {
            if (fn.constructor.name !== "AsyncFunction") {
                throw new Error("Function " + fn.name + " is not async. Only async functions can be registered.");
            }

            // Index functions by name (these are the node names)
            dataflow.nameToFn.set(fn.name, fn);

            // Extract param names from function (these are the upstream dep names)
            const paramNames = getParamNames(fn);
            
            // Create DAG
            dataflow.nodeToUpstreamNodes.set(fn.name, paramNames);
            for (const usName of paramNames) {
                var dsFns = dataflow.nodeToDownstreamNodes.get(usName);
                if (!dsFns) {
                    dataflow.nodeToDownstreamNodes.set(usName, dsFns = []);
                }
                dsFns.push(fn.name);
            }
        }
    },

    set: async function(nameToValuesObj) {
        // Visit a node and its transitive closure
        const visitNode = (name, visited, visitedInPath, fnVisitor) => {
            if (visitedInPath.has(name)) {
                throw new Error("Cycle detected, consisting of nodes: " + visitedInPath);
            }
            visitedInPath.add(name);
            if (!visited.has(name)) {
                visited.add(name);
                // Visit downstream functions of node recursively
                const dsFnNames = dataflow.nodeToDownstreamNodes.get(name);
                if (dsFnNames) {
                    for (const dsFnName of dsFnNames) {
                        const dsFn = dataflow.nameToFn.get(dsFnName);
                        // Call visitor lambda on function node
                        fnVisitor(dsFn);
                        // Recurse to function node
                        visitNode(dsFnName, visited, visitedInPath, fnVisitor);
                    }
                }
            }
            visitedInPath.delete(name);
        };
        // Visit the downstream transisive closure starting from a list of param names
        const visitReachableFnsFromParams = (paramNames, fnVisitor) => {
            const visited = new Set();
            const visitedInPath = new Set();
            for (const paramName of paramNames) {
                visitNode(paramName, visited, visitedInPath, fnVisitor);
            }
        }
        // Update the value of a node, and propagate any change downstream
        const setNodeValue = (name, value, dirtyNodeNamesOut) => {
            // Only propagate value if it changed
            const oldValue = dataflow.value[name];
            if (oldValue !== value) {
                if (DEBUG_DATAFLOW) {
                    console.log("Setting: " + name + " = " + value);
                }
                dataflow.value[name] = value;
                // Mark direct downstream nodes as dirty
                const dsFnNames = dataflow.nodeToDownstreamNodes.get(name);
                if (dsFnNames) {
                    dsFnNames.forEach(dsFnName => {
                        const dsFn = dataflow.nameToFn.get(dsFnName);
                        if (--dsFn.numDirtyDeps == 0) {
                            // The current node is the last dependency of the downstream node that
                            // needs updating, so the downstream node can be updated
                            dirtyNodeNamesOut.push(dsFnName);
                        }
                    });
                }
            } else {
                if (DEBUG_DATAFLOW) {
                    console.log("Unchanged: " + name + " = " + value);
                }
            }
        }

        // Changes need to be scheduled, so that code running inside a node's function can call set.
        // If set is called while a node's function is running, the update will be only be run after
        // the current complete dataflow update has completed.
        // This allows for dynamic dataflow, in batched mode.
        dataflow.updateBatches.enqueue(nameToValuesObj);

        // Don't process the updateBatches queue if there is already a Promise processing these batches
        if (!dataflow.inProgress) {
            dataflow.inProgress = true;
            while (!dataflow.updateBatches.isEmpty()) {
                const updateBatch = dataflow.updateBatches.dequeue();
                
                // Find the downstream transitive closure from all nodes reachable from the nodes listed
                // in updateBatch, and count the number of dirty upstream dependencies for each node
                [...dataflow.nameToFn.values()].forEach(fn => fn.numDirtyDeps = 0);
                visitReachableFnsFromParams(Object.keys(updateBatch), (fn) => fn.numDirtyDeps++);
                
                // Set the values of the nodes named in updateBatch, creating the initial dirty set of
                // direct downstream dependencies
                var dirtyNodeNames = [];
                for (const [name, value] of Object.entries(updateBatch)) {
                    setNodeValue(name, value, dirtyNodeNames);
                }

                // Propagate changes until all nodes in the transitive closure have been updated
                while (dirtyNodeNames.length > 0) {
                    // Schedule and await all pending function calls.
                    // For all (async) functions corresponding to dirty nodes,
                    // fetch the cached value for all upstream deps (i.e. all params),
                    // call the function, and collect the resulting promise.
                    const promises = dirtyNodeNames.map(name => {
                        // Get the named function
                        const fn = dataflow.nameToFn.get(name);
                        // Get cached upstream node values for each parameter of fn
                        const params = [];
                        for (const paramName of dataflow.nodeToUpstreamNodes.get(name)) {
                            const paramVal = dataflow.value[paramName];
                            params.push(paramVal);
                        }
                        // Call fn with these params, returning the resulting promise
                        if (DEBUG_DATAFLOW) {
                            console.log("Calling: " + name + "(" + params + ")");
                        }
                        return fn(...params);
                    });
                    
                    // Wait for all promises to be resolved, yielding maximal concurrency
                    await Promise.all(promises);

                    // Clear the dirty nodes list to prep for the next stage of wavefront propagation
                    const prevDirtyNodeNames = dirtyNodeNames;
                    dirtyNodeNames = [];
                    
                    // Set the node value to the function return value for all functions that were called
                    for (var i = 0; i < prevDirtyNodeNames.length; i++) {
                        setNodeValue(prevDirtyNodeNames[i], await promises[i], dirtyNodeNames);
                    }
                }
            }
            dataflow.inProgress = false;
        }
    },
};

