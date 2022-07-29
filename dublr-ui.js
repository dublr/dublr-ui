
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

const dollarRegexp = /[-]?[0-9]*([.][0-9][0-9])?/;

function formatDollars(amt) {
    const matches = amt.match(dollarRegexp);
    if (!matches) {
        return undefined;
    }
    return matches[0]; // Rounds down to nearest 1c by truncation
}

// Format to 12 significant figures, but keep all figures before the decimal.
// (It doesn't follow the strict definition of significant figures, because
// if the number has more than 12 digits to the left of the decimal point,
// the least-significant digits of the integer part won't be set to zero,
// and if the number is positive but less than 1.0, every zero counts as a
// "significant figure", meaning it switches to displaying 11 decimal points
// regardless of whether they are zeroes or not.
// Also truncates (rounds down) at the last digit.
// In other words this is a pretty lazy (utilitarian) number formatter.
function formatSF(num) {
    const targetSF = 12;
    let numSF = 0;
    let hitDot = false;
    let out = "";
    for (var i = 0; i < num.length; i++) {
        const c = num.charAt(i);
        if (c == ".") {
            hitDot = true;
            if (numSF >= targetSF) {
                break;
            }
        } else {
            if (hitDot && numSF >= targetSF) {
                break;
            }
            if (!isNaN(c)) {
                // Count all digits on left of decimal
                numSF++;
            }
        }
        out += c;            
    }
    return out;
}

function weiToDisplay(amtWEI, currency, priceUSDPerCurrency) {
    if (amtWEI === undefined) {
        return "(unknown)";
    }
    const amtWEIStr = formatSF(ethers.utils.formatEther(amtWEI));
    let amtUSDFormatted;
    if (priceUSDPerCurrency !== undefined) {
        const price = currency === "ETH" ? priceUSDPerCurrency.eth : priceUSDPerCurrency.dublr;
        if (price !== undefined) {
            const priceUSDPerCurrency_x1e9 = Math.floor(price * 1e9);
            const amtUSDWEI = amtWEI.mul(priceUSDPerCurrency_x1e9).div(1e9);
            const amtUSDStr = formatSF(ethers.utils.formatEther(amtUSDWEI));
            amtUSDFormatted = formatDollars(amtUSDStr);
        }
    }
    return amtWEIStr + " " + currency
            + (amtUSDFormatted === undefined ? "" : " (≈" + amtUSDFormatted + " USD)");
}

function ethToWei(eth) {
    return ethers.utils.parseEther(eth);
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

function makeSubTable(keys, values) {
    let html = "<table class='no-alt-bg' style='margin-left: auto; margin-right: auto;'>";
    html += "<tbody>";
    if (keys.length !== values.length) {
        throw new Error("keys.length !== values.length");
    }
    for (var i = 0; i < values.length; i++) {
        const label = keys[i];
        const value = values[i];
        html += "<tr>";
        html += "<td class='num-label'>" + keys[i] + "</td>";
        html += "<td class='num'>" + values[i] + "</td>";
        html += "</tr>";
    }
    html += "</tbody>";
    html += "</table>";
    return html;
}

// Based on https://stackoverflow.com/a/21742107/3950982
function isMobile() {
    var userAgent = navigator.userAgent || navigator.vendor || window.opera;
    window.alert(userAgent);
    return /windows phone/i.test(userAgent)
        || /android/i.test(userAgent)
        || (/iPad|iPhone|iPod/.test(userAgent) && !window.MSStream);
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
        dataflow.set({
            networkInfo_out: "",
            networkInfoIsWarning_out: false,
            etherscanURL_out: "https://github.com/dublr/dublr"
        });
        return undefined;
    }
    
    const network = await safe(provider.getNetwork());
    const networkNameRaw = !network || network.name === "" ? "(Unknown)"
        : network.name === "homestead" ? "mainnet" : network.name;
    const networkName = networkNameRaw.charAt(0).toUpperCase() + networkNameRaw.slice(1);
    
    const contract = new ethers.Contract(dublrAddr, dublrABI, provider);
    // Check DUBLR contract is deployed on this network
    const code = await safe(provider.getCode(dublrAddr));
    if (code && code.length <= 2) {
        // If code is "0x" then there is no contract currently deployed at address
        dataflow.set({
            networkInfo_out: "The Dublr contract is not deployed on " + networkName,
            networkInfoIsWarning_out: true,
            etherscanURL_out: "https://github.com/dublr/dublr"
        });
        return undefined;
    } else {
        const url = networkName === "(Unknown)" ? ""
                : networkName === "Mainnet" ? "https://etherscan.io/address/" + dublrAddr
                : "https://" + networkName.toLowerCase() + ".etherscan.io/address/" + dublrAddr;
        dataflow.set({
            networkInfo_out: "Blockchain network: <span class='num'>" + networkName + "</span>",
            networkInfoIsWarning_out: false,
            etherscanURL_out: url
        });
        return contract.connect(provider.getSigner());
    }
}

async function buyingEnabled(dublr, dublrStateTrigger) {
    return !dublr ? undefined : await safe(dublr.callStatic.buyingEnabled());
}

async function sellingEnabled(dublr, dublrStateTrigger) {
    return !dublr ? undefined : await safe(dublr.callStatic.sellingEnabled());
}

async function mintingEnabled(dublr, dublrStateTrigger) {
    return !dublr ? undefined : await safe(dublr.callStatic.mintingEnabled());
}

async function balanceETHWEI(provider, wallet, dublrStateTrigger) {
    return !provider || !wallet ? undefined : await safe(provider.getBalance(wallet));
}

async function balanceDUBLRWEI(dublr, wallet, dublrStateTrigger) {
    return !dublr || !wallet ? undefined : await safe(dublr.callStatic.balanceOf(wallet));
}

async function minSellOrderValueETHWEI(dublr, dublrStateTrigger) {
    return !dublr ? undefined : await safe(dublr.callStatic.minSellOrderValueETHWEI());
}

// Timer that fires every 60 seconds to trigger the mint price and ETH price updates
setInterval(() => dataflow.set({ priceTimerTrigger: Date.now() }), 60 * 1000);

// Update mint price every 60 seconds
async function mintPriceETHPerDUBLR_x1e9(dublr, dublrStateTrigger, priceTimerTrigger) {
    if (!dublr) {
        dataflow.set({mintPrice_out: "(unknown)"});  // Pushed to UI
        return undefined;        
    } else {
        const mintPrice_x1e9 = await safe(dublr.callStatic.mintPrice());
        if (mintPrice_x1e9 === undefined) {
            dataflow.set({mintPrice_out: "(unknown)"});
            return undefined;
        }
        dataflow.set({ mintPrice_out: formatPrice(mintPrice_x1e9) + " ETH per DUBLR"});  // Pushed to UI
        return mintPrice_x1e9;
    }
}

// From https://dmitripavlutin.com/timeout-fetch-request/
async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 8000 } = options;
  
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  const response = await fetch(resource, {
    ...options,
    signal: controller.signal  
  });
  clearTimeout(id);
  return response;
}

// Update price of USD per ETH and USD per DUBLR every 60 seconds
async function priceUSDPerCurrency(priceTimerTrigger) {
    var price = {};
    try {
        const response = await fetchWithTimeout(
                "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,dublr&vs_currencies=usd",
                { timeout: 3000 });
        const json = await response.json();
        const parsedEthPrice = Number.parseFloat(json?.ethereum?.usd);
        price.eth = isNaN(parsedEthPrice) ? undefined : parsedEthPrice;
        const parsedDublrPrice = Number.parseFloat(json?.dublr?.usd);
        price.dublr = isNaN(parsedDublrPrice) ? undefined : parsedDublrPrice;
    } catch (e) {
        const err = e.message === "The user aborted a request." ? "CoinGecko API timeout" : e;
        console.log("Could not fetch ETH price:", err);
    }
    return price;
}

async function orderBook(dublr, mySellOrder, mintPriceETHPerDUBLR_x1e9, priceUSDPerCurrency, dublrStateTrigger) {
    if (!dublr) {
        dataflow.set({
            orderbookTable_out: "",
            orderBookNote_out: "(No Dublr contract on this network)"
        });
        return undefined;
    }
    
    // Get and sort orderbook entries
    let orderBookEntries = await safe(dublr.callStatic.allSellOrders());
    if (orderBookEntries === undefined) {
        dataflow.set({
            orderbookTable_out: "",
            orderBookNote_out: "(Could not read orderbook)"
        });
        return undefined;
    } else if (orderBookEntries.length === 0) {
        dataflow.set({
            orderbookTable_out: "",
            orderBookNote_out: "(Orderbook is empty)"
        });
        return [];
    }
    
    // TODO: check sorting works in increasing order of price
    orderBookEntries.sort((a, b) => a.priceETHPerDUBLR_x1e9.lt(b.priceETHPerDUBLR_x1e9) ? -1 : 1);

    // Update UI with orderbook entries
    let tableRows = "";    
    let note = "";
    let cumulAmtETHWEI = ethers.BigNumber.from(0);
    let matchedMySellOrder = false;
    for (var idx = 0; idx < orderBookEntries.length; idx++) {
        var sellOrder = orderBookEntries[idx];
        // Check if order matches the wallet's own sell order
        const sellOrderMatches = mySellOrder !== undefined
                && mySellOrder.priceETHPerDUBLR_x1e9.eq(sellOrder.priceETHPerDUBLR_x1e9)
                && mySellOrder.amountDUBLRWEI.eq(sellOrder.amountDUBLRWEI);
        const isMySellOrder = sellOrderMatches && !matchedMySellOrder;
        if (isMySellOrder) {
            matchedMySellOrder = true;
            note = "➡️ : Your active sell order";
        }
        const aboveMintPrice = mintPriceETHPerDUBLR_x1e9 !== undefined
                && sellOrder.priceETHPerDUBLR_x1e9.gt(mintPriceETHPerDUBLR_x1e9);
        if (aboveMintPrice) {
            note += (note.length === 0 ? "" : "<br/>")
                + "🔺 : Sell order is priced above mint price (can't be bought yet)";
        }
        const amtETHWEI = dublrToEth(sellOrder.priceETHPerDUBLR_x1e9, sellOrder.amountDUBLRWEI);
        cumulAmtETHWEI = cumulAmtETHWEI.add(amtETHWEI);
        tableRows +=
            // Set font-family so that the emoji isn't monochrome
            "<tr><td style='border-right: 1px solid silver;'>"
            + "<span style='font-family: \"Maven Pro\";'>"
            + (isMySellOrder ? "➡️<br/>" : "") + (aboveMintPrice ? "🔺<br/>" : "") + "</span>#"
            + (idx + 1) + ":</td><td>" + makeSubTable(
                ["Price (ETH per DUBLR):", "Amount (DUBLR):", "Value (ETH):", "Cumul Value (ETH):"],
                [
                    formatPrice(sellOrder.priceETHPerDUBLR_x1e9),
                    weiToDisplay(sellOrder.amountDUBLRWEI, "DUBLR", priceUSDPerCurrency),
                    weiToDisplay(amtETHWEI, "ETH", priceUSDPerCurrency),
                    weiToDisplay(cumulAmtETHWEI, "ETH", priceUSDPerCurrency)
                ]
        ) + "</td></tr>";
    }
    // TODO:
    const tableHTML =
        "<table style='margin-left: auto; margin-right: auto; "
        + "border-collapse: separate; border-spacing: 0 .5em;'>"
        + "<tbody>" + tableRows + "</tbody></table>";
    dataflow.set({ orderbookTable_out: tableHTML, orderBookNote_out: note });

    return orderBookEntries;
}

async function mySellOrder(dublr, priceUSDPerCurrency, dublrStateTrigger) {
    if (!dublr) {
        dataflow.set({ mySellOrderTable_out: "", noSellOrderListed_out: "(None)", cancelSellViz_out: "none" });
        return undefined;
    }
    const sellOrder = await safe(dublr.callStatic.mySellOrder());
    if (sellOrder && !sellOrder.priceETHPerDUBLR_x1e9.isZero() && !sellOrder.amountDUBLRWEI.isZero()) {
        const amtETHWEI = dublrToEth(sellOrder.priceETHPerDUBLR_x1e9, sellOrder.amountDUBLRWEI);
        const amtLessFeeETHWEI = amtETHWEI.mul(9985).div(10000);  // Subtract 0.15% fee
        const tableHTML = makeSubTable(
            ["Price (ETH per DUBLR):", "Amount (DUBLR):", "Value (ETH):", "Value after fee (ETH):"],
            [
                formatPrice(sellOrder.priceETHPerDUBLR_x1e9),
                weiToDisplay(sellOrder.amountDUBLRWEI, "DUBLR", priceUSDPerCurrency),
                weiToDisplay(amtETHWEI, "ETH", priceUSDPerCurrency),
                weiToDisplay(amtLessFeeETHWEI, "ETH", priceUSDPerCurrency)
            ]
        );
        dataflow.set({ mySellOrderTable_out: tableHTML, noSellOrderListed_out: "", cancelSellViz_out: "block" });
        return sellOrder;
    }
}

async function minSellOrderValueETHWEI(dublr, priceUSDPerCurrency, dublrStateTrigger) {
    if (!dublr) {
        dataflow.set({ minSellOrderValue_out: "(unknown)" });
         return undefined;
    }
    const val = await safe(dublr.callStatic.minSellOrderValueETHWEI());
    dataflow.set({
        minSellOrderValue_out: val === undefined ? "(unknown)"
            : weiToDisplay(val, "ETH", priceUSDPerCurrency)
    });
    return val;
}

async function gasFeeDataETHWEI(provider, dublrStateTrigger) {
    return !provider ? undefined : await safe(provider.getFeeData());
}

// Validation functions for dataflow input from DOM -----------------------------

let oldAllowBuying = true;
let oldAllowMinting = true;

// Force at least one of the buy or mint checkboxes to be checked
async function constrainBuyMintCheckboxes(allowBuying, allowMinting) {
    let ab = allowBuying === undefined ? true : allowBuying;
    let am = allowMinting === undefined ? true : allowMinting;
    if (ab === false && am === false) {
        ab = !oldAllowBuying;
        am = !oldAllowMinting;
    }
    // Push outputs (this also potentially triggers the checkboxes to update, forcing at least one on)
    dataflow.set({ allowBuying: ab, allowMinting: am });
    oldAllowBuying = ab;
    oldAllowMinting = am;
}

async function buyAmountETHWEI(buyAmount_in, minSellOrderValueETHWEI, balanceETHWEI, priceUSDPerCurrency) {
    let warningText = "";
    let amountETHWEI;
    if (buyAmount_in !== undefined) {
        try {
            amountETHWEI = ethToWei(buyAmount_in);
        } catch (e) {
            warningText = "Not a number";
        }
        if (amountETHWEI !== undefined) {
            if (!amountETHWEI.gt(0)) {
                warningText = "Amount must be greater than zero";
                amountETHWEI = undefined;
            } else if (balanceETHWEI === undefined) {
                // Only output amount if ETH balance of wallet is known, since the amount
                // has to be smaller than the balance. But still clear the warning text.
                amountETHWEI = undefined;
            } else if (!amountETHWEI.lt(balanceETHWEI)) {
                warningText = "Amount must be less than wallet ETH balance";
                // The amount specified is unusable, so don't propagate it
                amountETHWEI = undefined;
            } else if (minSellOrderValueETHWEI !== undefined && amountETHWEI.lt(minSellOrderValueETHWEI)) {
                warningText = "You may buy this amount; however, since this is less than the minimum sell order value of "
                    + weiToDisplay(minSellOrderValueETHWEI, "ETH", priceUSDPerCurrency)
                    + ", then you will not be able to sell these tokens on the Dublr DEX, unless you sell for a high"
                    + " enough price or buy more. You may or may not be able to sell smaller orders elsewhere.";
            }
        }
    }
    // Update UI
    dataflow.set({buyAmountWarning_out: warningText});
    return amountETHWEI;
}

// Gas estimation and simulation of buy -----------------------------------

async function gasEstETHWEI(provider, dublr, gasFeeDataETHWEI, buyAmountETHWEI, balanceETHWEI,
        allowBuying, allowMinting, priceTimerTrigger) {
    if (!provider || !dublr || !buyAmountETHWEI || allowBuying === undefined || allowMinting === undefined
            || !gasFeeDataETHWEI || !balanceETHWEI) {
        dataflow.set({ gasEstWarning_out: "" });
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
    let warningText = "";
    try {
        const gasEstRaw = await dublr.estimateGas.buy(
                0, // Allow any amount of slippage
                allowBuying, allowMinting,
                // Simulate sending the specified amount of ETH, with gas limit set to prev block gas limit
                {value: buyAmountETHWEI, gasLimit: gasLimit});
        // Get gas price -- options: gasPrice, maxFeePerGas, maxPriorityFeePerGas
        const gasPriceETHWEI = gasFeeDataETHWEI.maxFeePerGas;
        // Calculate gas expenditure by multiplying by gas price
        gasEstETHWEI = gasEstRaw.mul(gasPriceETHWEI);
        // Warn if ETH amount plus estimated gas is less than ETH balance
        if (buyAmountETHWEI !== undefined && balanceETHWEI !== undefined
                && !gasEstETHWEI.add(buyAmountETHWEI).lt(balanceETHWEI)) {
            warningText = "Insufficient ETH balance for amount to spend plus estimated gas";
        }
    } catch (e) {
        const reason = e.reason ? e.reason : e?.message ? e.message
                : e.error?.message ? e.error.message : "unknown reason";
        if (reason.includes("insufficient funds")) {
            warningText = "Insufficient ETH balance for amount to spend plus estimated gas";
        } else if (reason.includes("out of gas")) {
            warningText = "Hit max gas limit, try buying a smaller amount";
        } else if (reason.includes("execution reverted")) {
            warningText = reason;
        } else {
            console.log("Could not estimate gas", e);
            warningText = "Could not estimate gas: " + reason;
        }
    }

    dataflow.set({ gasEstWarning_out: warningText });
    return gasEstETHWEI;
}

async function maxSlippageFrac(maxSlippage_in) {
    let slippageWarningText = "";
    let slippageFrac;
    if (maxSlippage_in !== undefined) {
        const maxSlippagePercent = Number(maxSlippage_in);
        if (maxSlippage_in === "" || isNaN(maxSlippagePercent)) {
            slippageWarningText = "Not a number";
        } else if (maxSlippagePercent < 0 || maxSlippagePercent > 100) {
            slippageWarningText = "Invalid percentage";
        } else if (amountBoughtEstDUBLRWEI !== undefined) {
            slippageFrac = 1e4 * (100 - maxSlippagePercent); // Percentage times 1e6 fixed point base
        }
    }
    dataflow.set({ slippageLimitWarning_out: slippageWarningText });
    return slippageFrac;
}

async function amountBoughtEstDUBLRWEI(balanceETHWEI, buyAmountETHWEI, allowBuying, allowMinting,
        buyingEnabled, mintingEnabled, orderBook, mySellOrder, maxSlippageFrac,
        mintPriceETHPerDUBLR_x1e9, gasEstETHWEI, priceUSDPerCurrency) {
    if (balanceETHWEI === undefined || buyAmountETHWEI === undefined
            || allowBuying === undefined || allowMinting === undefined
            || orderBook === undefined || mintPriceETHPerDUBLR_x1e9 === undefined
            || maxSlippageFrac === undefined) {
        dataflow.set({
            executionPlan_out: "",
            minimumTokensToBuyOrMintDUBLRWEI: undefined,
        });
        return undefined;
    }
    let result = "<b>Simulating buy function using current orderbook:</b><br/>"
    result += "<ul style='margin-top: 8px; margin-bottom: 8px;'>";
    if (orderBook.length == 0) {
        result += "<li>Orderbook is empty</li>";
    }
    if (allowMinting && mintPriceETHPerDUBLR_x1e9.eq(0)) {
        result += "<li>Minting period has ended; minting is no longer available</li>";
    }
    if (allowBuying && !buyingEnabled) {
        result += "<li>Buying of sell orders is currently disabled</li>";
    }
    if (!allowBuying && buyingEnabled) {
        result += "<li>You disallowed buying</li>";
    }
    if (allowMinting && !mintingEnabled) {
        result += "<li>Minting of new tokens is currently disabled</li>";
    }
    if (!allowMinting && mintingEnabled) {
        result += "<li>You disallowed minting</li>";
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
    let tableRows = "";
    let numBought = 0;
    while (buyingEnabled && allowBuying && buyOrderRemainingETHWEI.gt(0) && orderBookCopy.length > 0) {
        skippedBuying = false;
        const sellOrder = orderBookCopy[0];
        if (mySellOrder !== undefined && ownSellOrder === undefined
                && mySellOrder.priceETHPerDUBLR_x1e9.eq(sellOrder.priceETHPerDUBLR_x1e9)
                && mySellOrder.amountDUBLRWEI.eq(sellOrder.amountDUBLRWEI)) {
            ownSellOrder = sellOrder;
            orderBookCopy.shift();
            result += "<li>Skipping own sell order</li>";
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
        numBought++;
        tableRows += "<tr><td>"
            + makeSubTable(["Buy:", "at price:", "for cost:"],
                [
                    weiToDisplay(amountToBuyDUBLRWEI, "DUBLR", priceUSDPerCurrency),
                    formatPrice(sellOrder.priceETHPerDUBLR_x1e9) + " ETH per DUBLR",
                    weiToDisplay(amountToChargeBuyerETHWEI, "ETH", priceUSDPerCurrency)
                ]) + "</td></tr>";
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
                result += "<li>Ran out of sell orders after buying " + numBought + " order"
                    + (numBought === 1 ? "" : "s") + "; switched to minting</li>";
            }
            tableRows += "<tr><td>"
                + makeSubTable(["Mint:", "at price:", "for cost:"],
                    [
                        weiToDisplay(amountToMintDUBLRWEI, "DUBLR", priceUSDPerCurrency),
                        formatPrice(mintPriceETHPerDUBLR_x1e9) + " ETH per DUBLR",
                        weiToDisplay(amountToMintETHWEI, "ETH", priceUSDPerCurrency)
                    ]) + "</td></tr>";
        }
    }
    if (tableRows.length > 0) {
        result += "<li>Steps completed:</li>";
    } else {
        result += "<li><span class='warning-text-large'>Nothing can be bought</span></li>";
    }
    result += "</ul>";
    if (tableRows.length > 0) {
        result += "<table style='margin-left: auto; margin-right: auto; margin-top: 0; "
            + "border-collapse: separate; border-spacing: 0 .5em;'>"
            + "<tbody>" + tableRows + "</tbody></table>";
    }
    result += "</ul>";
    result += "<div style='margin-top: 12px; margin-bottom: 8px;'><b>Result:</b></div>";
    let summaryLabels = [];
    let summaryValues = [];
    const totalToSpendETHWEI = buyAmountETHWEI.sub(buyOrderRemainingETHWEI);
    summaryLabels.push("Total to spend:");
    summaryValues.push(weiToDisplay(totalToSpendETHWEI, "ETH", priceUSDPerCurrency));
    if (buyOrderRemainingETHWEI > 0) {
        summaryLabels.push("Refunded change:");
        summaryValues.push(weiToDisplay(buyOrderRemainingETHWEI, "ETH", priceUSDPerCurrency));
    }
    summaryLabels.push("Total to receive:");
    summaryValues.push(weiToDisplay(totBoughtOrMintedDUBLRWEI, "DUBLR", priceUSDPerCurrency));
    let minimumTokensToBuyOrMintDUBLRWEI = totBoughtOrMintedDUBLRWEI.mul(Math.floor(maxSlippageFrac)).div(1e6);
    summaryLabels.push("Min w/ slippage:");
    summaryValues.push(weiToDisplay(minimumTokensToBuyOrMintDUBLRWEI, "DUBLR", priceUSDPerCurrency));
    if (gasEstETHWEI !== undefined) {
        summaryLabels.push("Gas estimate:");
        summaryValues.push(weiToDisplay(gasEstETHWEI, "ETH", priceUSDPerCurrency));
    }

    result += makeSubTable(summaryLabels, summaryValues);
    
    dataflow.set({
        executionPlan_out: result,
        minimumTokensToBuyOrMintDUBLRWEI: minimumTokensToBuyOrMintDUBLRWEI,
    });
    return totBoughtOrMintedDUBLRWEI;
}

// UI update functions ----------------------------------------------------

async function updateWalletUI(provider, wallet, balanceETHWEI, balanceDUBLRWEI, priceUSDPerCurrency) {
    dataflow.set({walletInfo_out: 
        "Wallet <span class='num'>" + (wallet ? formatAddress(wallet) : "(not connected)") + "</span> balances:<br/>"
            + "<span class='num'>" + weiToDisplay(balanceETHWEI, "ETH", priceUSDPerCurrency) + "</span><br/>"
            + "<span class='num'>" + weiToDisplay(balanceDUBLRWEI, "DUBLR", priceUSDPerCurrency) + "</span><br/>"
            + "</span>"
    });
}

async function buyButtonParams(dublr, buyAmountETHWEI, minimumTokensToBuyOrMintDUBLRWEI,
        amountBoughtEstDUBLRWEI, allowBuying, allowMinting, gasEstWarning_out, termsBuy_in) {
    const disabled = !dublr
        // Double-check that the ETH amount is nonzero
        || !buyAmountETHWEI || buyAmountETHWEI.eq(0)
        // Require that the buy simulation was able to buy a nonzero amount of DUBLR
        || !amountBoughtEstDUBLRWEI || amountBoughtEstDUBLRWEI.eq(0) || !minimumTokensToBuyOrMintDUBLRWEI
        // One of allowBuying or allowMinting must be checked
        || allowBuying === undefined || allowMinting === undefined || (!allowBuying && !allowMinting)
        // Don't allow buying if there's a gas estimation warning showing
        || gasEstWarning_out
        // Terms must be agreed to
        || !termsBuy_in;
    document.getElementById("buyButton").disabled = disabled;
    return disabled ? undefined : {
        // Group all dependencies together in a single object, so that they can be accessed
        // atomically by the buy button's onclick handler
        dublr: dublr, buyAmountETHWEI: buyAmountETHWEI,
        minimumTokensToBuyOrMintDUBLRWEI: minimumTokensToBuyOrMintDUBLRWEI,
        allowBuying: allowBuying, allowMinting: allowMinting
    };
}

// DOMContentLoaded handler ---------------------------------------------------

window.addEventListener("DOMContentLoaded", async () => {
    
    // Register dataflow functions -------------------------------------------
    
    // DEBUG_DATAFLOW = true;

    dataflow.register(
        constrainBuyMintCheckboxes, buyAmountETHWEI,
        provider, dublr, balanceETHWEI, balanceDUBLRWEI,
        mintPriceETHPerDUBLR_x1e9, priceUSDPerCurrency,
        buyingEnabled, sellingEnabled, mintingEnabled,
        orderBook, mySellOrder, minSellOrderValueETHWEI,
        gasFeeDataETHWEI, maxSlippageFrac,
        gasEstETHWEI, amountBoughtEstDUBLRWEI,
        updateWalletUI, buyButtonParams,
    );

    // Seed the dataflow graph with initial price estimates
    dataflow.set({ priceTimerTrigger: 0 });
    
    // Register all reactive elements to set the corresponding input in the dataflow graph based on id.
    // Seeds the dataflow graph with the initial values of input elements in the UI.
    dataflow.connectToDOM();

    // Hook up action buttons ----------------------------------------------------------
    
    document.getElementById("buyButton").onclick = async (event) => {
        event.preventDefault();
        await dataflow.set({});  // Wait for dataflow to end, so that buyButtonParams is most recent version
        const buyParams = dataflow.value.buyButtonParams;
        if (buyParams) {
            // This can take a while to run, since calling a contract via MetaMask requires user interaction.
            // Launch this in a new Promise, and don't wait for the result, so that dataflow is not held up.
            new Promise(async () => {
                try {
                    dataflow.set({
                        buyStatus_out: "",
                        buyStatusIsWarning_out: false
                    });
                    // Call the Dublr `buy` function
                    await buyParams.dublr.buy(
                            buyParams.minimumTokensToBuyOrMintDUBLRWEI,
                            buyParams.allowBuying, buyParams.allowMinting,
                            // Don't provide a gas limit, because MetaMask ignores it anyway
                            // and calculates gas itself
                            { value: buyParams.buyAmountETHWEI }
                    );
                    dataflow.set({
                        buyStatus_out: "Transaction submitted successfully",
                        buyStatusIsWarning_out: false
                    });
                } catch (e) {
                    let warningText = "";
                    const reason = e.reason ? e.reason : e?.message ? e.message
                            : e.error?.message ? e.error.message : "unknown reason";
                    if (reason.includes("insufficient funds")) {
                        warningText = "Insufficient ETH balance for amount to spend plus gas";
                    } else if (reason.includes("out of gas")) {
                        warningText = "Ran out of gas, try buying a smaller amount";
                    } else if (reason.includes("execution reverted")) {
                        warningText = reason;
                    } else if (reason.includes("User denied transaction")) {
                        warningText = "Transaction rejected by user";
                    } else {
                        console.log(e);
                        warningText = "Could not buy tokens: " + reason;
                    }
                    dataflow.set({
                        buyStatus_out: "Previous result: " + warningText,
                        buyStatusIsWarning_out: true
                    });
                }
            });
        }
    };

    
    document.getElementById("cancelSellOrderButton").onclick = async (event) => {
        event.preventDefault();
        await dataflow.set({});
    }

    // MetaMask onboarding / connection with wallet -----------------------------------
    
    // Push wallet changes and chainId changes into the dataflow graph
    // (this allows the UI to work with account changes and chainId changes without reloading)
    const setAccounts = async (accounts) => {
        dataflow.set({ wallet: accounts?.length > 0 ? accounts[0] : undefined });
    };
    const setChainId = async (chainId) => {
        dataflow.set({ chainId: chainId });
    };
    
    // Onboarding flow (modified from docs)
    const onboarding = new MetaMaskOnboarding();
    const onboardButton = document.getElementById("onboard");
    const onboardText = document.getElementById("onboard-text");
    let notOriginallyInstalled = false;
    let listenersAdded = false;
    const updateButton = async () => {
        if (!MetaMaskOnboarding.isMetaMaskInstalled()) {
            notOriginallyInstalled = true;
            if (isMobile()) {
                // Mobile onboarding
                onboardText.innerText = "Open in Metamask Browser";
                onboardButton.onclick = () => {
                    onboardText.innerText = "Opening in MetaMask browser";
                    onboardButton.disabled = true;
                    // URL generated by https://metamask.github.io/metamask-deeplinks
                    window.location.href = "https://metamask.app.link/dapp/dublr.github.io/dublr-ui";
                };
            } else {
                // Desktop onboarding
                onboardText.innerText = "Click here to install MetaMask";
                onboardButton.onclick = () => {
                    onboardText.innerText = "Waiting for MetaMask to be installed";
                    onboardButton.disabled = true;
                    onboarding.startOnboarding();
                };
            }
        } else {
            if (!listenersAdded) {
                // Add account change listeners only once
                window.ethereum.on("accountsChanged", async (accounts) => {
                    setAccounts(accounts);
                    await updateButton();
                });
                window.ethereum.on("chainChanged", async (chainId) => {
                    setChainId(chainId);
                    await updateButton();
                });
                window.ethereum.on("disconnect", (error) => {
                    // https://docs.metamask.io/guide/ethereum-provider.html#events
                    // "In general, this will only happen due to network connectivity issues
                    // or some unforeseen error." (Just log and ignore this.)
                    console.log("MetaMask disconnected", error);
                });
                listenersAdded = true;
            }
            // Test if connected without actually requesting accounts --
            // eth_accounts does not pop up MetaMask UI
            const accounts = await window.ethereum.request({method: "eth_accounts"});
            setAccounts(accounts);
            if (accounts?.length > 0) {
                onboardText.innerText = "Connected to MetaMask wallet";
                onboardButton.disabled = true;
                onboarding.stopOnboarding();
                
                const metaMaskProvider = new ethers.providers.Web3Provider(window.ethereum);
                dataflow.set({chainId: (await metaMaskProvider.getNetwork()).chainId});
                
                if (notOriginallyInstalled) {
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
                    // eth_requestAccounts pops up the MetaMask wallet
                    const accounts = await window.ethereum.request({method: "eth_requestAccounts"});
                    setAccounts(accounts);
                    await updateButton();
                };
            }
        }
    };
    updateButton();
});

