
// Dublr contract -------------------------------------------------

const dublrAddr = "0x795fc0A43A8C1Db020CB243d76383a50BAA8CD24";    // TODO: This is the Rinkeby test address

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
        "function mintPrice() external view returns (uint256 mintPriceETHPerDUBLR_x1e9)",
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

function dublrToETH(price_x1e9, amtDUBLR) {
    return amtDUBLR.mul(price_x1e9).div(1e9);
}

function ethToDUBLR(price_x1e9, amtETH) {
    return amtETH.mul(1e9).div(price_x1e9);
}

// Dataflow functions ----------------------------------------------

async function provider(ethInstance) {
    if (!ethInstance) {
        return undefined;
    }
    
    // Connect Ethers to MetaMask
    const metaMaskProvider = new ethers.providers.Web3Provider(ethInstance);

    // Listen to all DUBLR events, and set dublrStateTrigger to the block number of any events that are emitted.
    // (This will cause only one dataflow change even if there are many events emitted in a single block.)
    metaMaskProvider.on({ address: dublrAddr }, (log, event) => {
        // Ignore log entries without block numbers (this includes RPC errors, such as reverted transactions)
        if (log?.blockNumber) {
            dataflow.set({ dublrStateTrigger: log.blockNumber });
        }
    });
    
    return metaMaskProvider;
}

async function dublr(provider) {
    return provider ? new ethers.Contract(dublrAddr, dublrABI, provider).connect(provider.getSigner()) : undefined;
}

async function ethBalance(provider, wallet, dublrStateTrigger) {
    return provider && wallet ? await provider.getBalance(wallet) : undefined;
}

async function dublrBalance(dublr, wallet, dublrStateTrigger) {
    return dublr && wallet ? await dublr.callStatic.balanceOf(wallet) : undefined;
}

// Update mint price every 60 seconds
setInterval(() => dataflow.set({ mintPriceTimerTrigger: Date.now() }), 60 * 1000);

async function mintPrice(dublr, mintPriceTimerTrigger) {
    return dublr ? await dublr.callStatic.mintPrice() : undefined;
}

async function orderBookSize(dublr, dublrStateTrigger) {
    return dublr ? ethers.BigNumber.from(await dublr.callStatic.orderBookSize()).toNumber() : undefined;
}

async function orderBook(dublr, orderBookSize, dublrStateTrigger) {
    if (!dublr || orderBookSize === undefined) {
        return undefined;
    }
    let orderBookEntries = [];
    if (orderBookSize > 0) {
        try {
            orderBookEntries = await dublr.callStatic.allSellOrders();
            // TODO: check sorting works in increasing order of price
            orderBookEntries.sort((a, b) => a.priceETHPerDUBLR_x1e9.lt(b.priceETHPerDUBLR_x1e9) ? -1 : 1);
        } catch (e) {
            // TODO: Rinkeby Dublr contract reverts when the last orderbook entry is removed -- ignore
        }
    }
    return orderBookEntries;
}

async function mySellOrder(dublr, dublrStateTrigger) {
    if (dublr) {
        try {
            const order = await dublr.callStatic.mySellOrder();
            if (!order.priceETHPerDUBLR_x1e9.isZero() && !order.amountDUBLRWEI.isZero()) {
                return order;
            }
        } catch (e) {
            // TODO: Rinkeby Dublr contract reverts if there is no sell order for user -- ignore
        }
    }
    return undefined;
}

async function minSellOrderValueETHWEI(dublr, dublrStateTrigger) {
    return dublr ? await dublr.callStatic.minSellOrderValueETHWEI() : undefined;
}

async function gasPrice(provider) {
    return await provider.getGasPrice();
}

async function gasEst(dublr, buyAmount, allowBuying, allowMinting, gasPrice, ethBalance) {
    if (dublr === undefined || buyAmount === undefined || allowBuying === undefined || allowMinting === undefined
            || gasPrice === undefined || ethBalance === undefined) {
        return undefined;
    }
    let buyAmtEthWei;
    try {
        buyAmtEthWei = ethers.utils.parseEther(buyAmount);
    } catch (e) {
        return "\"Amount to spend\" is not a number";
    }
    if (buyAmtEthWei.gt(ethBalance)) {
        return "Reduce \"Amount to spend\" below wallet ETH balance"
    }
    try {
        const gasAmt = await dublr.estimateGas.buy(
                // Set minimumTokensToBuyOrMintDUBLRWEI to 0 to prevent transaction reverting due to slippage
                0, allowBuying, allowMinting,
                // Simulate sending the specified amount of ETH, with max gas limit
                {value: buyAmtEthWei, gasLimit: 3e7});
        return gasAmt.mul(gasPrice);
    } catch (e) {
        const reason = e.reason ? e.reason : e.error && e.error.message ? e.error.message : "unknown reason";
        if (reason.startsWith("insufficient funds")) {
            return "Insufficient ETH balance for amount plus gas";
        } else if (reason.contains("out of gas")) {
            return "Hit max gas limit, try buying a smaller amount";
        } else if (reason.startsWith("execution reverted")) {
            return reason;
        }
        return "Could not estimate gas: " + reason;
    }
}

let gasManuallyModified = false;

async function gasProvidedModified(gasProvided) {
    // After gas is manually modified, don't update it based on the gas estimate
    gasManuallyModified = true;
}

async function updateWalletUI(wallet, ethBalance, dublrBalance) {
    const walletInfoSpan = document.getElementById("wallet-info");
    walletInfoSpan.innerHTML = "<tt>Wallet <b>" 
            + (wallet ? formatAddress(wallet) : "(not connected)") + "</b> balances:<br/>"
            + "<b>" + (ethBalance ? ethers.utils.formatEther(ethBalance) : "(unknown)") + "</b> ETH<br/>"
            + "<b>" + (dublrBalance ? ethers.utils.formatEther(dublrBalance) : "(unknown)") + "</b> DUBLR</tt>";
}

async function updateMintPriceUI(mintPrice) {
    const mintPriceSpan = document.getElementById("mint-price");
    mintPriceSpan.innerHTML = (mintPrice ? formatPrice(mintPrice) : "(unknown)");
}

async function updateOrderBookUI(orderBook) {
    let tbody = "";    
    let cumulAmtETH = ethers.BigNumber.from(0);
    if (orderBook) {
        for (const order of orderBook) {
            const amtETH = dublrToETH(order.priceETHPerDUBLR_x1e9, order.amountDUBLRWEI);
            cumulAmtETH = cumulAmtETH.add(amtETH);
            tbody += "<trow><td align=\"right\"><tt>" + formatPrice(order.priceETHPerDUBLR_x1e9)
                    + "</tt></td><td align=\"right\"><tt>" + ethers.utils.formatEther(order.amountDUBLRWEI)
                    + "</tt></td><td align=\"right\"><tt>" + ethers.utils.formatEther(amtETH)
                    + "</tt></td><td align=\"right\"><tt>" + ethers.utils.formatEther(cumulAmtETH)
                    + "</tt></td></trow>";
        }
    }
    const orderbookTbody = document.getElementById("orderbook-tbody");
    orderbookTbody.innerHTML = tbody;
}

async function updateBuyUI(gasEst) {
    document.getElementById("gas-est").value =
        gasEst === undefined ? "(unknown)" : gasEst instanceof ethers.BigNumber ? ethers.utils.formatEther(gasEst) : gasEst;
    if (!gasManuallyModified) {
        // Add 20% to the gas to provide, on top of the estimate
        document.getElementById("gasProvided").value =
            gasEst instanceof ethers.BigNumber ? ethers.utils.formatEther(gasEst.mul(6).div(5)) : "";
    }
}

let oldAllowBuying = true;
let oldAllowMinting = true;
dataflow.set({ allowBuying: true, allowMinting: true });

// Force at least one of the buy or mint checkboxes to be checked
async function constrainBuyMintCheckboxes(allowBuying, allowMinting) {
    if (allowBuying === false && allowMinting === false) {
        if (oldAllowBuying) {
            document.getElementById("allowMinting").checked = true;
            dataflow.set({ allowMinting: true });
        } else {
            document.getElementById("allowBuying").checked = true;
            dataflow.set({ allowBuying: true });
        }
    }
    oldAllowBuying = allowBuying;
    oldAllowMinting = allowMinting;
}

dataflow.register(
    provider, dublr, ethBalance, dublrBalance, mintPrice,
    orderBookSize, orderBook,
    mySellOrder, minSellOrderValueETHWEI,
    gasPrice, gasEst, gasProvidedModified,
    updateWalletUI, updateMintPriceUI, updateOrderBookUI,
    updateBuyUI, constrainBuyMintCheckboxes,
);


window.addEventListener("DOMContentLoaded", async () => {
    
    // TODO: why does hitting Enter on the page result in the page being refreshed?
    
    // UI setup ------------------------------------------------------------------------
    
    DEBUG_DATAFLOW = true;
    
    // Register all reactive elements to set the corresponding input in the dataflow graph based on id
    [...document.getElementsByClassName("reactive-input")].forEach(elt => {
        elt.addEventListener("change", () => {
            const value = elt.type === "checkbox" || elt.type === "radio" ? elt.checked : elt.value;
            dataflow.set({ [elt.id]: value });
        });
    });

    // MetaMask Onboarding flow (modified from docs) -----------------------------------
    
    const onboarding = new MetaMaskOnboarding();
    const onboardButton = document.getElementById("onboard");
    const onboardText = document.getElementById("onboard-text");
    let notOriginallyConnected = false;
    let accounts = !MetaMaskOnboarding.isMetaMaskInstalled() ? [] : await window.ethereum.request({
        method: "eth_requestAccounts",
    });

    const updateButton = async () => {
        if (!MetaMaskOnboarding.isMetaMaskInstalled()) {
            onboardText.innerText = "Click here to install MetaMask";
            onboardButton.onclick = () => {
                onboardText.innerText = "Waiting for MetaMask to be installed";
                onboardButton.disabled = true;
                onboarding.startOnboarding();
            };
        } else if (accounts && accounts.length > 0) {
            onboardText.innerText = "Connected to MetaMask wallet";
            onboardButton.disabled = true;
            onboarding.stopOnboarding();
            if (notOriginallyConnected) {
                // Only try adding token if wallet was not originally connected
                // (i.e. MetaMask cookie will serve as a proxy for determining whether DUBLR
                // token was already added to wallet)
                try {
                    if (await ethereum.request({
                        method: "wallet_watchAsset",
                        params: {
                            type: "ERC20", options: {
                                address: dublrAddr, symbol: "DUBLR", decimals: 18,
                                image: "https://raw.githubusercontent.com/dublr/dublr/main/icon.png" }
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
            // Connect Ethers to MetaMask, and to the Dublr contract; set wallet
            dataflow.set({ ethInstance: window.ethereum, wallet: accounts[0] });
        } else {
            notOriginallyConnected = true;
            onboardText.innerText = "Connect to MetaMask wallet";
            onboardButton.onclick = async () => {
                accounts = await window.ethereum.request({
                    method: "eth_requestAccounts",
                });
                if (accounts && accounts.length > 0) {
                    await updateButton();
                }
            };
        }
    };
    await updateButton();
    
    if (MetaMaskOnboarding.isMetaMaskInstalled()) {
        window.ethereum.on("accountsChanged", async (newAccounts) => {
            accounts = newAccounts;
            await updateButton();
        });
        window.ethereum.on("chainChanged", (chainId) => {
            if (chainId != 1) {
                alert("DUBLR contract is only officially launched on mainnet; chainId " + chainId + " is unsupported");
            }
            window.location.reload();
        });
    }
});

