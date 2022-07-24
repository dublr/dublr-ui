
// Dublr contract -------------------------------------------------

const dublrAddr = "0xa823fe789B32b1566fF6931E6e0d0E8c2C51435B";    // TODO: This is the Rinkeby test address

const dublrABI = [
        "event ListSell(address indexed seller, uint256 priceETHPerDUBLR_x1e9, uint256 amountDUBLRWEI)",
        "event CancelSell(address indexed seller, uint256 priceETHPerDUBLR_x1e9, uint256 amountDUBLRWEI)",
        "event Buy(address indexed buyer, address indexed seller, uint256 priceETHPerDUBLR_x1e9, uint256 amountBoughtDUBLRWEI,"
            + " uint256 amountRemainingInOrderDUBLRWEI, uint256 amountSentToSellerETHWEI, uint256 amountChargedToBuyerETHWEI)",
        "event Mint(address indexed buyer, uint256 priceETHPerDUBLR_x1e9, uint256 amountSpentETHWEI, uint256 amountMintedDUBLRWEI)",
        "event OutOfGasForBuyingSellOrders(address indexed buyer, uint256 buyOrderRemainingETHWEI, uint256 totBoughtDUBLRWEI)",
        "event RefundChange(address indexed buyer, uint256 refundedETHWEI)",
        "event Unpayable(address indexed seller, uint256 amountETHWEI, bytes data)",
        "function orderBookSize() view returns (uint256 numEntries)",
        "function cheapestSellOrder() view returns (uint256 priceETHPerDUBLR_x1e9, uint256 amountDUBLRWEI)",
        "function mySellOrder() view returns (uint256 priceETHPerDUBLR_x1e9, uint256 amountDUBLRWEI)",
        "function cancelMySellOrder()",
        "function allSellOrders() view returns ((uint256 priceETHPerDUBLR_x1e9, uint256 amountDUBLRWEI)[] memory priceAndAmountOfSellOrders)",
        "function sell(uint256 priceETHPerDUBLR_x1e9, uint256 amountDUBLRWEI)",
        "function buy(uint256 minimumTokensToBuyOrMintDUBLRWEI, bool allowBuying, bool allowMinting) payable",
        "function minSellOrderValueETHWEI() returns (uint256)",
        "function buyingEnabled() returns (bool)",
        "function sellingEnabled() returns (bool)",
        "function mintingEnabled() returns (bool)",
        "function mintPrice() external view returns (uint256 mintPrice)",
        "function balanceOf(address addr) returns (uint256)",
];

// Formatting functions -------------------------------------------

const ADDR_REGEXP = /^(0x[a-zA-Z0-9]{3})[a-zA-Z0-9]+([a-zA-Z0-9]{4})$/;

// Return an address in the same format as MetaMask
function formatAddress(addr) {
    const match = addr.match(ADDR_REGEXP);
    if (!match) return addr;
    return `${match[1]}...${match[2]}`;
}

function formatPrice(price_x1e9) {
    return (price_x1e9 * 1e-9).toFixed(9);
}

function dublrToEthRoundUpClamped(price_x1e9, amtDUBLR, maxAmtETH) {
    const amtETH = (amtDUBLR.mul(price_x1e9).add(1e9-1)).div(1e9);
    return amtETH.lt(maxAmtETH) ? amtETH : maxAmtETH;
}

function dublrToEth(price_x1e9, amtDUBLR) {
    return amtDUBLR.mul(price_x1e9).div(1e9);
}

function ethToDublr(price_x1e9, amtETH) {
    return amtETH.mul(1e9).div(price_x1e9);
}

async function safe(promise) {
    try {
        const result = await promise;
        return result;
    } catch (e) {
        console.log(e);
        return undefined;
    }
}

// Dataflow inputs from Dublr contract ----------------------------------------------

async function provider(chainId) {
    if (!chainId) {
        return undefined;
    }
    
    // Connect Ethers to MetaMask
    const metaMaskProvider = new ethers.providers.Web3Provider(window.ethereum);

    // Listen to all DUBLR events, and set dublrStateTrigger to the block number of any events
    // that are emitted. Using the block number as the state trigger will cause only one dataflow
    // change even if there are many events emitted in a single block.
    metaMaskProvider.on({ address: dublrAddr }, (log, event) => {
        // Ignore log entries without block numbers (this includes RPC errors, such as reverted
        // transactions)
        if (log?.blockNumber) {
            dataflow.set({ dublrStateTrigger: log.blockNumber });
        }
    });
    
    return metaMaskProvider;
}

async function dublr(provider, wallet) {
    if (!provider || !wallet) {
        dataflow.set({networkError: ""});
        return undefined;
    }
    const contract = new ethers.Contract(dublrAddr, dublrABI, provider);
    // Check DUBLR contract is deployed on this network
    const code = await safe(provider.getCode(dublrAddr));
    if (code && code.length <= 2) {
        // If code is "0x" then there is no contract currently deployed at address
        const network = await safe(provider.getNetwork());
        const networkName = !network || network.name === "" ? "(Unknown network)"
            : network.name === "homestead" ? "mainnet" : network.name;
        const networkNameCapd = networkName.charAt(0).toUpperCase() + networkName.slice(1);
        dataflow.set({networkError: "The Dublr contract is not deployed on " + networkNameCapd});
        return undefined;
    } else {
        dataflow.set({networkError: ""});
        return contract.connect(provider.getSigner());
    }
}

async function buyingEnabled(dublr) {
    return !dublr ? undefined : await safe(dublr.callStatic.buyingEnabled());
}

async function sellingEnabled(dublr) {
    return !dublr ? undefined : await safe(dublr.callStatic.sellingEnabled());
}

async function mintingEnabled(dublr) {
    return !dublr ? undefined : await safe(dublr.callStatic.mintingEnabled());
}

async function ethBalance(provider, wallet, dublrStateTrigger) {
    return !provider || !wallet ? undefined : await safe(provider.getBalance(wallet));
}

async function dublrBalance(dublr, wallet, dublrStateTrigger) {
    return !dublr || !wallet ? undefined : await safe(dublr.callStatic.balanceOf(wallet));
}

// Update mint price every 60 seconds
setInterval(() => dataflow.set({ mintPriceTimerTrigger: Date.now() }), 60 * 1000);

async function mintPriceETHPerDUBLR_x1e9(dublr, mintPriceTimerTrigger) {
    if (!dublr) {
        dataflow.set({mintPrice: "unknown"});  // Pushed to UI
        return undefined;        
    } else {
        const mintPrice_x1e9 = await safe(dublr.callStatic.mintPrice());
        if (mintPrice_x1e9 === undefined) {
            dataflow.set({mintPrice: "unknown"});
            return undefined;
        }
        dataflow.set({mintPrice: formatPrice(mintPrice_x1e9) + " ETH per DUBLR"});  // Pushed to UI
        return mintPrice_x1e9;
    }
}

async function orderBookSize(dublr, dublrStateTrigger) {
    if (!dublr) {
        return undefined;
    }
    const size = await safe(dublr.callStatic.orderBookSize());
    return !size ? undefined : ethers.BigNumber.from(size).toNumber();
}

async function orderBook(dublr, orderBookSize, dublrStateTrigger) {
    if (!dublr || orderBookSize === undefined) {
        dataflow.set({orderbookRows: ""});
        return undefined;
    }
    
    // Get and sort orderbook entries
    let orderBookEntries = [];
    if (orderBookSize > 0) {
        orderBookEntries = await safe(dublr.callStatic.allSellOrders());
        if (orderBookEntries === undefined) {
            dataflow.set({orderbookRows: ""});
            return undefined;
        }
        // TODO: check sorting works in increasing order of price
        orderBookEntries.sort((a, b) => a.priceETHPerDUBLR_x1e9.lt(b.priceETHPerDUBLR_x1e9) ? -1 : 1);
    }

    // Update UI with orderbook entries
    let tbody = "";    
    let cumulAmtETH = ethers.BigNumber.from(0);
    for (const order of orderBookEntries) {
        const amtETH = dublrToEth(order.priceETHPerDUBLR_x1e9, order.amountDUBLRWEI);
        cumulAmtETH = cumulAmtETH.add(amtETH);
        tbody += "<trow><td align=\"right\"><tt>" + formatPrice(order.priceETHPerDUBLR_x1e9)
                + "</tt></td><td align=\"right\"><tt>" + ethers.utils.formatEther(order.amountDUBLRWEI)
                + "</tt></td><td align=\"right\"><tt>" + ethers.utils.formatEther(amtETH)
                + "</tt></td><td align=\"right\"><tt>" + ethers.utils.formatEther(cumulAmtETH)
                + "</tt></td></trow>";
    }
    dataflow.set({orderbookRows: tbody});

    return orderBookEntries;
}

async function mySellOrder(dublr, dublrStateTrigger) {
    if (dublr) {
        const order = await safe(dublr.callStatic.mySellOrder());
        if (order && !order.priceETHPerDUBLR_x1e9.isZero() && !order.amountDUBLRWEI.isZero()) {
            return order;
        }
    }
    return undefined;
}

async function minSellOrderValueETHWEI(dublr, dublrStateTrigger) {
    return !dublr ? undefined : await safe(dublr.callStatic.minSellOrderValueETHWEI());
}

async function gasPriceETHWEI(provider) {
    return !provider ? undefined : await safe(provider.getGasPrice());
}

// Validation functions for dataflow input from DOM -----------------------------

let oldAllowBuying = true;
let oldAllowMinting = true;

// Force at least one of the buy or mint checkboxes to be checked
async function constrainBuyMintCheckboxes(allowBuyingUI, allowMintingUI) {
    let allowBuying = allowBuyingUI === undefined ? true : allowBuyingUI;
    let allowMinting = allowMintingUI === undefined ? true : allowMintingUI;
    if (allowBuying === false && allowMinting === false) {
        allowBuying = !oldAllowBuying;
        allowMinting = !oldAllowMinting;
    }
    // Push outputs (this also potentially triggers the checkboxes to update, forcing at least one on)
    dataflow.set({ allowBuying: allowBuying, allowMinting: allowMinting,
                   allowBuyingUI: allowBuying, allowMintingUI: allowMinting });
    oldAllowBuying = allowBuying;
    oldAllowMinting = allowMinting;
}

async function buyAmountETHWEI(buyAmountUI, ethBalance) {
    let warningText = "";
    let amountETHWEI;
    if (buyAmountUI !== undefined) {
        try {
            amountETHWEI = ethers.utils.parseEther(buyAmountUI);
        } catch (e) {
            warningText = "Not a number";
        }
        if (amountETHWEI !== undefined) {
            if (!amountETHWEI.gt(0)) {
                warningText = "Amount must be greater than zero";
                amountETHWEI = undefined;
            } else if (ethBalance === undefined) {
                // Only output amount if ETH balance of wallet is known, since the amount
                // has to be smaller than the balance. But still clear the warning text.
                amountETHWEI = undefined;
            } else if (!amountETHWEI.lt(ethBalance)) {
                warningText = "Amount must be less than wallet ETH balance";
                // The amount specified is unusable, so don't propagate it
                amountETHWEI = undefined;
            }
        }
    }
    // Update UI
    dataflow.set({buyAmountWarning: warningText});
    return amountETHWEI;
}

async function maxGasToProvideETHWEI(maxGasToProvideUI, gasEstETHWEI) {
    if (maxGasToProvideUI === undefined) {
        dataflow.set({maxGasToProvideWarning: ""});
        return undefined;
    }
    let warningText = "";
    let gasETHWEI;
    if (maxGasToProvideUI.length > 0) {
        try {
            gasETHWEI = ethers.utils.parseEther(maxGasToProvideUI);
        } catch (e) {
            warningText = "Not a number";
        }
        if (gasETHWEI !== undefined) {
            if (!gasETHWEI.gt(0)) {
                warningText = "Gas must be greater than zero";
                gasETHWEI = undefined;
            } else if (gasEstETHWEI != undefined && gasETHWEI.lt(gasEstETHWEI)) {
                warningText = "Gas is lower than estimate; transaction may not complete, or may stop early";
            }
        }
    }
    // Update UI
    dataflow.set({maxGasToProvideWarning: warningText});
    return gasETHWEI;
}

async function minimumTokensToBuyOrMintDUBLRWEI(amountBoughtEstDUBLRWEI, maxSlippageUI) {
    if (maxSlippageUI === undefined) {
        dataflow.set({minDublr: undefined, slippageLimitWarning: ""});    
        return undefined;
    }
    let warningText = "";
    let minAmountETHWEI;
    const maxSlippagePercent = Number(maxSlippageUI);
    if (isNaN(maxSlippagePercent)) {
        warningText = "Not a number";
    } else if (maxSlippagePercent < 0 || maxSlippagePercent > 100) {
        warningText = "Invalid percentage";
    } else if (amountBoughtEstDUBLRWEI !== undefined) {
        const slippageFrac = 1e4 * (100 - maxSlippagePercent); // Percentage times 1e6 fixed point base
        minAmountETHWEI = amountBoughtEstDUBLRWEI.mul(Math.floor(slippageFrac)).div(1e6);
    }
    const minDublr = minAmountETHWEI === undefined ? "" : ethers.utils.formatEther(minAmountETHWEI);
    dataflow.set({minDublr: minDublr, slippageLimitWarning: warningText});    
    return minAmountETHWEI;
}

// Gas estimation and simulation of buy -----------------------------------

async function gasEstETHWEI(provider, dublr, buyAmountETHWEI, allowBuying, allowMinting,
        gasPriceETHWEI, ethBalance) {
    if (!provider || !dublr || !buyAmountETHWEI || allowBuying === undefined || allowMinting === undefined
            || !gasPriceETHWEI || !ethBalance) {
        dataflow.set({gasEstUI: undefined, maxGasToProvideUI: undefined, gasEstWarning: ""});
        return undefined;
    }
    const blockNumber = await safe(provider.getBlockNumber());
    const block = !blockNumber ? undefined : await safe(provider.getBlock(blockNumber));
    if (!block) {
        return undefined;
    }
    const gasLimit = block.gasLimit;
    let gasEstETHWEI;
    let gasEstETH;
    let maxGasToProvideUI;
    let warningText = "";
    try {
        const gasEstRaw = await dublr.estimateGas.buy(
                // Set minimumTokensToBuyOrMintDUBLRWEI to 0 to prevent transaction reverting due to slippage
                0,
                allowBuying, allowMinting,
                // Simulate sending the specified amount of ETH, with gas limit set to prev block gas limit
                {value: buyAmountETHWEI, gasLimit: gasLimit});
        // Calculate gas expenditure by multiplying by gas price
        gasEstETHWEI = gasEstRaw.mul(gasPriceETHWEI);
        // Calculate gas estimate for UI
        gasEstUI = ethers.utils.formatEther(gasEstETHWEI);
        // Calculate max gas to provide, by adding 33% to gas amount
        const gasEstETHWEIWithMargin = gasEstETHWEI.mul(4).div(3);
        // Overwrite value in "Max gas to provide" field with latest computed value
        maxGasToProvideUI = ethers.utils.formatEther(gasEstETHWEIWithMargin);
    } catch (e) {
        const reason = e.reason ? e.reason : e.error?.message ? e.error.message : "unknown reason";
        if (reason.startsWith("insufficient funds")) {
            warningText = "Insufficient ETH balance for amount plus gas";
        } else if (reason.includes("out of gas")) {
            warningText = "Hit max gas limit, try buying a smaller amount";
        } else if (reason.startsWith("execution reverted")) {
            warningText = reason;
        } else {
            console.log("Could not estimate gas", e);
            warningText = "Could not estimate gas: " + reason;
        }
    }
    dataflow.set({gasEstUI: gasEstUI, maxGasToProvideUI: maxGasToProvideUI, gasEstWarning: warningText});
    return gasEstETHWEI;
}

async function amountBoughtEstDUBLRWEI(ethBalance, buyAmountETHWEI, allowBuying, allowMinting,
        buyingEnabled, mintingEnabled, orderBook, mySellOrder, mintPriceETHPerDUBLR_x1e9) {
    if (ethBalance === undefined || buyAmountETHWEI === undefined
            || allowBuying === undefined || allowMinting === undefined
            || orderBook === undefined || mintPriceETHPerDUBLR_x1e9 === undefined) {
        dataflow.set({expectedDublr: undefined, executionPlanLines: ""});
        return undefined;
    }
    if (!buyAmountETHWEI.lt(ethBalance)) {
        dataflow.set({expectedDublr: undefined,
                executionPlanLines: "\"Amount to spend\" must be less than wallet ETH balance"});
        return undefined;
    }
    let result = [];
    if (orderBook.length == 0) {
        result.push("Orderbook is empty");
    }
    if (allowBuying && !buyingEnabled) {
        result.push("Buying of sell orders is currently disabled");
    }
    if (!allowBuying && buyingEnabled) {
        result.push("You disallowed buying");
    }
    if (allowMinting && !mintingEnabled) {
        result.push("Minting of new tokens is currently disabled");
    }
    if (!allowMinting && mintingEnabled) {
        result.push("You disallowed minting");
    }
    // The following is the _buy_stateUpdater method from Dublr.sol, rewritten in JS but without gas checks
    // or seller payment logic. This had to be ported because estimateGas can't return any contract state.
    let buyOrderRemainingETHWEI = buyAmountETHWEI;
    const zero = ethers.BigNumber.from(0);
    let totBoughtOrMintedDUBLRWEI = zero;
    let totSpentETHWEI = zero;
    const orderBookCopy = orderBook.map(
            (order) => ({priceETHPerDUBLR_x1e9: order.priceETHPerDUBLR_x1e9, amountDUBLRWEI: order.amountDUBLRWEI}));
    let ownSellOrder;
    let skipMinting = false;
    let skippedBuying = true;
    while (buyingEnabled && allowBuying && buyOrderRemainingETHWEI.gt(0) && orderBookCopy.length > 0) {
        skippedBuying = false;
        const sellOrder = orderBookCopy[0];
        if (mySellOrder !== undefined && ownSellOrder === undefined
                && mySellOrder.priceETHPerDUBLR_x1e9.eq(sellOrder.priceETHPerDUBLR_x1e9)
                && mySellOrder.amountDUBLRWEI.eq(sellOrder.amountDUBLRWEI)) {
            ownSellOrder = sellOrder;
            orderBookCopy.shift();
            result.push("Skipping own sell order");
            continue;
        }
        if (mintPriceETHPerDUBLR_x1e9.gt(0)
                && sellOrder.priceETHPerDUBLR_x1e9.gt(mintPriceETHPerDUBLR_x1e9)) {
            break;
        }
        const amountBuyerCanAffordAtSellOrderPrice_asDUBLRWEI =
                ethToDublr(sellOrder.priceETHPerDUBLR_x1e9, buyOrderRemainingETHWEI);
        if (amountBuyerCanAffordAtSellOrderPrice_asDUBLRWEI.isZero()) {
            skipMinting = true;
            break;
        }
        const amountToBuyDUBLRWEI = sellOrder.amountDUBLRWEI.lt(amountBuyerCanAffordAtSellOrderPrice_asDUBLRWEI)
                ? sellOrder.amountDUBLRWEI : amountBuyerCanAffordAtSellOrderPrice_asDUBLRWEI;
        const amountToChargeBuyerETHWEI = dublrToEthRoundUpClamped(
                sellOrder.priceETHPerDUBLR_x1e9, amountToBuyDUBLRWEI, buyOrderRemainingETHWEI);
        orderBookCopy[0].amountDUBLRWEI = orderBookCopy[0].amountDUBLRWEI.sub(amountToBuyDUBLRWEI);
        const sellOrderRemainingDUBLRWEI = orderBookCopy[0].amountDUBLRWEI;
        if (sellOrderRemainingDUBLRWEI.isZero()) {
            orderBookCopy.shift();
        }
        totBoughtOrMintedDUBLRWEI = totBoughtOrMintedDUBLRWEI.add(amountToBuyDUBLRWEI);
        buyOrderRemainingETHWEI = buyOrderRemainingETHWEI.sub(amountToChargeBuyerETHWEI);
        totSpentETHWEI = totSpentETHWEI.add(amountToChargeBuyerETHWEI);
        result.push("Buy: " + ethers.utils.formatEther(amountToBuyDUBLRWEI) + " DUBLR");
        result.push("&nbsp;&nbsp;&nbsp;&nbsp;at price: "
                + formatPrice(sellOrder.priceETHPerDUBLR_x1e9) + " ETH per DUBLR");
        result.push("&nbsp;&nbsp;&nbsp;&nbsp;for cost: "
                + ethers.utils.formatEther(amountToChargeBuyerETHWEI) + " ETH");
    }
    if (mintingEnabled && allowMinting && !skipMinting
            && mintPriceETHPerDUBLR_x1e9.gt(0) && buyOrderRemainingETHWEI.gt(0)) {
        const amountToMintDUBLRWEI = ethToDublr(mintPriceETHPerDUBLR_x1e9, buyOrderRemainingETHWEI);
        const amountToMintETHWEI = dublrToEthRoundUpClamped(
                mintPriceETHPerDUBLR_x1e9, amountToMintDUBLRWEI, buyOrderRemainingETHWEI);
        if (amountToMintDUBLRWEI > 0) {
            totBoughtOrMintedDUBLRWEI = totBoughtOrMintedDUBLRWEI.add(amountToMintDUBLRWEI);
            buyOrderRemainingETHWEI = buyOrderRemainingETHWEI.sub(amountToMintETHWEI);
            totSpentETHWEI = totSpentETHWEI.add(amountToMintETHWEI);
            if (!skippedBuying) {
                result.push("Ran out of sell orders; switching to minting");
            }
            result.push("Mint: " + ethers.utils.formatEther(amountToMintDUBLRWEI) + " DUBLR");
            result.push("&nbsp;&nbsp;&nbsp;&nbsp;at price: " + formatPrice(mintPriceETHPerDUBLR_x1e9)
                    + " ETH per DUBLR");
            result.push("&nbsp;&nbsp;&nbsp;&nbsp;for cost: " + ethers.utils.formatEther(amountToMintETHWEI)
                    + " ETH");
        }
    }
    result.push("Total to spend: " + ethers.utils.formatEther(buyAmountETHWEI.sub(buyOrderRemainingETHWEI))
            + " ETH");
    if (buyOrderRemainingETHWEI > 0) {
        result.push("Change to refund: " + ethers.utils.formatEther(buyOrderRemainingETHWEI) + " ETH");
    }
    
    // Convert lines to HTML and push out to execution plan element in UI
    let executionPlanLines = "";
    for (line of result) {
        if (executionPlanLines.length > 0) {
            executionPlanLines += "<br/>";
        }
        executionPlanLines += line;
    }
    dataflow.set({expectedDublr: ethers.utils.formatEther(totBoughtOrMintedDUBLRWEI),
            executionPlanLines: executionPlanLines});
    return totBoughtOrMintedDUBLRWEI;
}

// UI update functions ----------------------------------------------------

async function updateWalletUI(provider, wallet, ethBalance, dublrBalance) {
    dataflow.set({walletInfo: 
        "Wallet <b>" + (wallet ? formatAddress(wallet) : "(not connected)") + "</b> balances:<br/>"
            + "<b>" + (ethBalance ? ethers.utils.formatEther(ethBalance) : "(unknown)") + "</b> ETH<br/>"
            + "<b>" + (dublrBalance ? ethers.utils.formatEther(dublrBalance) : "(unknown)") + "</b> DUBLR"
    });
}

async function enableBuyButton(dublr, buyAmountETHWEI, maxGasToProvideETHWEI, gasPriceETHWEI,
        minimumTokensToBuyOrMintDUBLRWEI, allowBuying, allowMinting, termsBuy) {
    const disabled = !dublr || !buyAmountETHWEI || !maxGasToProvideETHWEI || !gasPriceETHWEI
        || !minimumTokensToBuyOrMintDUBLRWEI || allowBuying === undefined || allowMinting === undefined
        || !termsBuy;
    document.getElementById("buyButton").disabled = disabled;
    return disabled ? undefined : {
        // Group all dependencies together in a single object, so that they can be accessed
        // atomically by the buy button's onclick handler
        dublr: dublr, buyAmountETHWEI: buyAmountETHWEI,
        gasLimit: maxGasToProvideETHWEI.div(gasPriceETHWEI),
        minimumTokensToBuyOrMintDUBLRWEI: minimumTokensToBuyOrMintDUBLRWEI,
        allowBuying: allowBuying, allowMinting: allowMinting
    };
}

// DOMContentLoaded handler ---------------------------------------------------

window.addEventListener("DOMContentLoaded", async () => {
    
    // Register dataflow functions -------------------------------------------
    
    DEBUG_DATAFLOW = true;

    dataflow.register(
        constrainBuyMintCheckboxes, buyAmountETHWEI, maxGasToProvideETHWEI,
        minimumTokensToBuyOrMintDUBLRWEI,
        
        provider, dublr, ethBalance, dublrBalance, mintPriceETHPerDUBLR_x1e9,
        buyingEnabled, sellingEnabled, mintingEnabled,
        orderBookSize, orderBook, mySellOrder, minSellOrderValueETHWEI,
        gasPriceETHWEI,
        
        gasEstETHWEI, amountBoughtEstDUBLRWEI,
        
        updateWalletUI, enableBuyButton,
    );
    
    // Register all reactive elements to set the corresponding input in the dataflow graph based on id
    dataflow.connectToDOM();

    // Hook up action buttons ----------------------------------------------------------
    
    // TODO: why does clicking Buy result in the page being reloaded?
    
    document.getElementById("buyButton").onclick = () => {
        const buyParams = dataflow.value.enableBuyButton;
        if (buyParams) {
            try {
                buyParams.dublr.buy(buyParams.minimumTokensToBuyOrMintDUBLRWEI,
                        buyParams.allowBuying, buyParams.allowMinting,
                        {value: buyParams.buyAmountETHWEI, gasLimit: buyParams.gasLimit});
                dataflow.set({buyError: ""});
            } catch (e) {
                let warningText = "";
                const reason = e.reason ? e.reason : e.error?.message ? e.error.message : "unknown reason";
                if (reason.startsWith("insufficient funds")) {
                    warningText = "Insufficient ETH balance for amount plus gas";
                } else if (reason.includes("out of gas")) {
                    warningText = "Ran out of gas, try buying a smaller amount or increase max gas";
                } else if (reason.startsWith("execution reverted")) {
                    warningText = reason;
                } else {
                    console.log(e);
                    warningText = "Could not buy tokens: " + reason;
                }
                dataflow.set({buyError: warningText});
            }
        }
    };

    // MetaMask Onboarding flow (modified from docs) -----------------------------------
    
    const onboarding = new MetaMaskOnboarding();
    const onboardButton = document.getElementById("onboard");
    const onboardText = document.getElementById("onboard-text");
    let notOriginallyConnected = false;
    let listenersAdded = false;
    let accounts;
    const updateButton = async () => {
        if (!MetaMaskOnboarding.isMetaMaskInstalled()) {
            notOriginallyConnected = true;
            onboardText.innerText = "Click here to install MetaMask";
            onboardButton.onclick = () => {
                onboardText.innerText = "Waiting for MetaMask to be installed";
                onboardButton.disabled = true;
                onboarding.startOnboarding();
            };
        } else {
            if (!listenersAdded) {
                window.ethereum.on("accountsChanged", async (accounts) => {
                    await updateButton();
                });
                window.ethereum.on("chainChanged", (chainId) => {
                    dataflow.set({chainId: chainId});
                });
                window.ethereum.on("disconnect", (error) => {
                    console.log(error);
                });
            }
            // Test if connected without actually requesting accounts
            accounts = await window.ethereum.request({method: "eth_accounts"});
            // Use first account as the wallet
            let wallet = accounts && accounts.length > 0 ? accounts[0] : undefined;
            dataflow.set({ wallet: wallet });
            if (wallet) {
                onboardText.innerText = "Connected to MetaMask wallet";
                onboardButton.disabled = true;
                onboarding.stopOnboarding();
                
                const metaMaskProvider = new ethers.providers.Web3Provider(window.ethereum);
                dataflow.set({chainId: (await metaMaskProvider.getNetwork()).chainId});
                
                if (notOriginallyConnected) {
                    // Only try adding token if MetaMask was not originally installed
                    // (i.e. MetaMask installation will serve as a proxy for determining whether DUBLR
                    // token was already added to wallet)
                    try {
                        if (await window.ethereum.request({
                            method: "wallet_watchAsset",
                            params: {
                                type: "ERC20", options: {
                                    address: dublrAddr, symbol: "DUBLR", decimals: 18,
                                    image: "https://raw.githubusercontent.com/dublr/dublr/main/icon.svg" }
                            }
                        })) {
                            // console.log("DUBLR token added to MetaMask");
                        } else {
                            console.log("DUBLR token could not be added to MetaMask");
                        }
                    } catch (error) {
                        console.log(error);
                    }
                }
            } else {
                onboardText.innerText = "Connect to MetaMask wallet";
                onboardButton.disabled = false;
                onboardButton.onclick = async () => {
                    // Pop up the MetaMask wallet
                    accounts = await window.ethereum.request({method: "eth_requestAccounts"});
                    await updateButton();
                };
            }
        }
    };
    await updateButton();
});

