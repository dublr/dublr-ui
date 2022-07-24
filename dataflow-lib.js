
let DEBUG_DATAFLOW = false;

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
    valueChanged: {},                  // name -> boolean
    inProgress: false,
    
    register: function(...fns) {
        for (const fn of fns) {
            if (!(fn instanceof Function)) {
                throw new Error("Parameter is not a function: " + fn);
            }
            if (fn.constructor.name !== "AsyncFunction") {
                throw new Error("Function " + fn.name + " is not async. Only async functions can be registered.");
            }
            if (dataflow.nameToFn.has(fn.name)) {
                throw new Error("Function is already registered: " + fn.name);
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
            const valueChanged = oldValue !== value;
            dataflow.valueChanged[name] = valueChanged;
            if (valueChanged) {
                if (DEBUG_DATAFLOW) {
                    console.log("Setting: " + name + " = " + value);
                }
                dataflow.value[name] = value;
            } else {
                if (DEBUG_DATAFLOW) {
                    console.log("Unchanged: " + name + " = " + value);
                }
            }
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
                    const promises = [];
                    const fnNames = [];
                    dirtyNodeNames.forEach(name => {
                        // Get the named function
                        const fn = dataflow.nameToFn.get(name);
                        // Get cached upstream node values for each parameter of fn
                        const params = [];
                        let someParamValueChanged = false;
                        for (const paramName of dataflow.nodeToUpstreamNodes.get(name)) {
                            if (dataflow.valueChanged[paramName]) {
                                someParamValueChanged = true;
                            }
                            const paramVal = dataflow.value[paramName];
                            params.push(paramVal);
                        }
                        fnNames.push(fn.name);
                        if (someParamValueChanged) {
                            // Only call fn if at least one param value changed, to avoid repeating work
                            // (i.e. implement memoization)
                            if (DEBUG_DATAFLOW) {
                                console.log("Calling: " + name + "(" + params + ")");
                            }
                            // Call fn with these params, returning the resulting promise
                            promises.push(fn(...params));
                        } else {
                            // Otherwise reuse cached val (we still need to propagate unchanged
                            // value down dataflow graph, so that fn.numDirtyDeps gets correctly
                            // decremented all the way down the transitive closure).
                            promises.push(Promise.resolve(dataflow.value[name]));
                        }
                    });
                    
                    // Wait for all promises to be resolved, yielding maximal concurrency
                    await Promise.all(promises);

                    // Clear the dirty nodes list to prep for the next stage of wavefront propagation
                    dirtyNodeNames = [];
                    
                    // Set the node value to the function return value for all functions that were called,
                    // and mark any downstream dependencies as dirty (ready for the next wave of change
                    // propagation) if all their upstream dependencies have been marked as resolved
                    // (no longer dirty, or unchanged).
                    for (var i = 0; i < fnNames.length; i++) {
                        setNodeValue(fnNames[i], await promises[i], dirtyNodeNames);
                    }
                }
            }
            dataflow.inProgress = false;
            if (DEBUG_DATAFLOW) {
                console.log("Dataflow ended");
            }
        }
    },
    
    connectToDOM: () => {
        const validName = /^[A-Z_$][0-9A-Z_$]*$/i;
        
        // dataflow to DOM:
        // Register dataflow functions to push values back out to the DOM when there are changes.
        const functionsToRegister = [];
        [...document.querySelectorAll("[from-dataflow]")].forEach(elt => {
            const dataflowOutputNodeName = elt.getAttribute("from-dataflow");
            if (!dataflowOutputNodeName || !validName.test(dataflowOutputNodeName)) {
                throw new Error("DOM element with from-dataflow attribute does not specify valid dataflow node name: "
                        + elt.outerHTML);
            }
            if (!elt.id || !validName.test(elt.id)) {
                throw new Error("DOM element with from-dataflow attribute does not have valid id: "
                        + elt.outerHTML);
            }
            // Figure out how to set the target
            let setter;
            const getEltById = "document.getElementById('" + elt.id + "')";
            if (elt.tagName.toLowerCase() === "input") {
                if (elt.type === "checkbox" || elt.type === "radio") {
                    setter = "if (" + dataflowOutputNodeName + " !== undefined) " + getEltById
                            + ".checked = " + dataflowOutputNodeName + ";";
                } else {
                    setter = getEltById + ".value = "
                            + dataflowOutputNodeName + " === undefined ? '' : " + dataflowOutputNodeName + ";";
                }
            } else {
                setter = getEltById + ".innerHTML = "
                            + dataflowOutputNodeName + " === undefined ? '' : " + dataflowOutputNodeName + ";";
            }
            // eval is the only way to create functions with both dynamic function names and dynamic parameter names
            const functionName = "setDOM_" + elt.id;
            eval("async function " + functionName + "(" + dataflowOutputNodeName + ") { " + setter + "; }");
            const fn = eval(functionName);
            functionsToRegister.push(fn);
        });
        // Register DOM update functions
        dataflow.register(...functionsToRegister);
        
        // DOM to dataflow:
        // Add change listeners to input elements in DOM that will push changes into the dataflow graph.
        // <input> elements should have class="dataflow-on-change" or class="dataflow-on-input", and
        // id="dataflowNodeName" (where dataflowNodeName needs to be a valid JS identifier).
        const getInputValue = (elt) => elt.type === "checkbox" || elt.type === "radio" ? elt.checked : elt.value;
        const initialValues = {};
        [...document.getElementsByClassName("to-dataflow-on-change")].forEach(elt => {
            if (!elt.id || !validName.test(elt.id)) {
                throw new Error("DOM element with to-dataflow-on-change class does not have valid id: "
                        + elt.outerHTML);
            }
            elt.addEventListener("change", () => dataflow.set({ [elt.id]: getInputValue(elt) }));
            initialValues[elt.id] = getInputValue(elt);
        });
        [...document.getElementsByClassName("to-dataflow-on-input")].forEach(elt => {
            if (!elt.id || !validName.test(elt.id)) {
                throw new Error("DOM element with to-dataflow-on-input class does not have valid id: "
                        + elt.outerHTML);
            }
            elt.addEventListener("input", () => dataflow.set({ [elt.id]: getInputValue(elt) }));
            initialValues[elt.id] = getInputValue(elt);
        });
        // Seed dataflow graph with initial values from DOM
        dataflow.set(initialValues);
    },
};

