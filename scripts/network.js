import { getDerivationPath } from './wallet.js';
import { cChainParams, COIN } from './chain_params.js';
import { createAlert } from './misc.js';
import { Mempool, UTXO } from './mempool.js';
import { EventEmitter } from 'events';

/**
 * Virtual class rapresenting any network backend
 */
export class Network {
    constructor(masterKey) {
        if (this.constructor === Network) {
            throw new Error('Initializing virtual class');
        }
        this._enabled = true;

	this.masterKey = masterKey;

        /**
         * @type {EventEmitter}
         * @public
         */
        this.eventEmitter = new EventEmitter();

        this.lastWallet = 0;
    }

    /**
     * @param {boolean} value
     */
    set enabled(value) {
        if (value !== this._enabled) {
            this.eventEmitter.emit('network-toggle', value);
            this._enabled = value;
        }
    }

    get enabled() {
        return this._enabled;
    }

    enable() {
        this.enabled = true;
    }

    disable() {
        this.enabled = false;
    }

    toggle() {
        this.enabled = !this.enabled;
    }

    getFee(bytes) {
        // TEMPORARY: Hardcoded fee per-byte
        return bytes * 50; // 50 sat/byte
    }

    get cachedBlockCount() {
        throw new Error('cachedBlockCount must be implemented');
    }

    error() {
        throw new Error('Error must be implemented');
    }

    getBlockCount() {
        throw new Error('getBlockCount must be implemented');
    }

    sentTransaction() {
        throw new Error('sendTransaction must be implemented');
    }

    submitAnalytics(strType, cData = {}) {
        throw new Error('submitAnalytics must be implemented');
    }

    setMasterKey(masterKey) {
	this.masterKey = masterKey;
    }
}

/**
 *
 */
export class ExplorerNetwork extends Network {
    /**
     * @param {string} strUrl - Url pointing to the blockbook explorer
     */
    constructor(strUrl, masterKey) {
        super(masterKey);
        /**
         * @type{string}
         * @public
         */
        this.strUrl = strUrl;

        /**
         * @type{Number}
         * @private
         */
        this.blocks = 0;

        this.arrRewards = [];
    }

    error() {
        if (this.enabled) {
            this.disable();
            createAlert(
                'warning',
                '<b>Failed to synchronize!</b> Please try again later.' +
                    '<br>You can attempt re-connect via the Settings.',
                []
            );
        }
    }

    get cachedBlockCount() {
        return this.blocks;
    }

    async getBlockCount() {
        try {
            const { backend } = await (
                await fetch(`${this.strUrl}/api/v2/api`)
            ).json();
            if (backend.blocks > this.blocks) {
                console.log(
                    'New block detected! ' +
                        this.blocks +
                        ' --> ' +
                        backend.blocks
                );
		this.blocks = backend.blocks;
                this.eventEmitter.emit('sync-status', 'start');
		this.getUTXOs();
            }
        } catch (e) {
            this.error();
            throw e;
        }
    }

    /**
     * Fetch UTXOs from the current primary explorer
     * @returns {Promise<void>} Resolves when it has finished fetching UTXOs
     */
    async getUTXOs() {
        // Don't fetch UTXOs if we're already scanning for them!
	if (!this.masterKey) return;
        if (this.isSyncing) return;
        this.isSyncing = true;
        try {
            let publicKey;
            if (this.masterKey.isHD) {
                const derivationPath = getDerivationPath(
                    this.masterKey.isHardwareWallet
                )
                    .split('/')
                    .slice(0, 4)
                    .join('/');
                publicKey = await this.masterKey.getxpub(derivationPath);
            } else {
                publicKey = await this.masterKey.getAddress();
            }

            this.eventEmitter.emit(
                'utxo',
                await (
                    await fetch(`${this.strUrl}/api/v2/utxo/${publicKey}`)
                ).json()
            );
        } catch (e) {
            console.error(e);
            this.error();
        } finally {
            this.isSyncing = false;
        }
    }
    /**
     * Fetches UTXOs full info
     * @param {Object} cUTXO - object-formatted UTXO
     * @returns {Promise<UTXO>} Promise that resolves with the full info of the UTXO
     */
    async getUTXOFullInfo(cUTXO) {
        const cTx = await (
            await fetch(`${this.strUrl}/api/v2/tx-specific/${cUTXO.txid}`)
        ).json();
        const cVout = cTx.vout[cUTXO.vout];

        let path;
        if (cUTXO.path) {
            path = cUTXO.path.split('/');
            path[2] =
                (this.masterKey.isHardwareWallet
                    ? cChainParams.current.BIP44_TYPE_LEDGER
                    : cChainParams.current.BIP44_TYPE) + "'";
            this.lastWallet = Math.max(parseInt(path[5]), this.lastWallet);
            path = path.join('/');
        }

        const isColdStake = cVout.scriptPubKey.type === 'coldstake';
        const isStandard = cVout.scriptPubKey.type === 'pubkeyhash';
        const isReward = cTx.vout[0].scriptPubKey.hex === '';
        // We don't know what this is
        if (!isColdStake && !isStandard) {
            return null;
        }

        return new UTXO({
            id: cUTXO.txid,
            path,
            sats: Math.round(cVout.value * COIN),
            script: cVout.scriptPubKey.hex,
            vout: cVout.n,
            height: this.cachedBlockCount - (cTx.confirmations - 1),
            status: cTx.confirmations < 1 ? Mempool.PENDING : Mempool.CONFIRMED,
            isDelegate: isColdStake,
            isReward,
        });
        // TODO: readd as event getNewAddress(true);
    }

    async sendTransaction(hex) {
        try {
            const data = await (
                await fetch(this.strUrl + '/api/v2/sendtx/', {
                    method: 'post',
                    body: hex,
                })
            ).json();
            if (data.result && data.result.length === 64) {
                console.log('Transaction sent! ' + data.result);
                this.eventEmitter.emit('transaction-sent', true);
                /*
		doms.domTxOutput.innerHTML =
                    '<h4 style="color:green; font-family:mono !important;">' +
                    data.result +
                    '</h4>';
		doms.domSimpleTXs.style.display = 'none';
		doms.domAddress1s.value = '';
		doms.domValue1s.innerHTML = '';
		createAlert(
                    'success',
                    msg || 'Transaction sent!',
                    msg ? 1250 + msg.length * 50 : 1500
		    );

		// If allowed by settings: submit a simple 'tx' ping to Labs Analytics
		submitAnalytics('transaction');
		*/
                return true;
            } else {
                console.log('Error sending transaction: ' + data.result);
                //createAlert('warning', 'Transaction Failed!', 1250);
                // Attempt to parse and prettify JSON (if any), otherwise, display the raw output.

                this.eventEmitter.emit('transaction-sent', false, data.error);
                /*doms.domTxOutput.innerHTML =
                    '<h4 style="color:red;font-family:mono !important;"><pre style="color: inherit;">' +
                    strError +
                    '</pre></h4>';*/
                return false;
            }
        } catch (e) {
            console.error(e);
            this.error();
        }
    }

    async getStakingRewards() {
        if (!this.enabled || !this.masterKey) return;
        const nHeight = this.arrRewards.length
            ? this.arrRewards[this.arrRewards.length - 1].blockHeight
            : 0;
        const mapPaths = new Map();
        const txSum = (v) =>
            v.reduce(
                (t, s) =>
                    t +
                    (s.addresses
                        .map((strAddr) => mapPaths.get(strAddr))
                        .filter((v) => v).length && s.addresses.length === 2
                        ? parseInt(s.value)
                        : 0),
                0
            );
        let cData;
        if (this.masterKey.isHD) {
            const derivationPath = getDerivationPath(
                this.masterKey.isHardwareWallet
            )
                .split('/')
                .slice(0, 4)
                .join('/');
            const xpub = await this.masterKey.getxpub(derivationPath);
            cData = await (
                await fetch(
                    `${
                        this.strUrl
                    }/api/v2/xpub/${xpub}?details=txs&pageSize=500&to=${
                        nHeight ? nHeight - 1 : 0
                    }`
                )
            ).json();
            // Map all address <--> derivation paths
            if (cData.tokens)
                cData.tokens.forEach((cAddrPath) =>
                    mapPaths.set(cAddrPath.name, cAddrPath.path)
                );
        } else {
            const address = await this.masterKey.getAddress();
            cData = await (
                await fetch(
                    `${
                        this.strUrl
                    }/api/v2/address/${address}?details=txs&pageSize=500&to=${
                        nHeight ? nHeight - 1 : 0
                    }`
                )
            ).json();
            mapPaths.set(address, ':)');
        }
        if (cData && cData.transactions) {
            // Update rewards
            this.arrRewards = this.arrRewards.concat(
                cData.transactions
                    .filter((tx) => tx.vout[0].addresses[0] === 'CoinStake TX')
                    .map((tx) => {
                        return {
                            id: tx.txid,
                            time: tx.blockTime,
                            blockHeight: tx.blockHeight,
                            amount: (txSum(tx.vout) - txSum(tx.vin)) / COIN,
                        };
                    })
                    .filter((tx) => tx.amount != 0)
            );

            // If the results don't match the full 'max/requested results', then we know there's nothing more to load, hide the button!
            /*
            if (cData.transactions.length !== cData.itemsOnPage)
            doms.domGuiStakingLoadMore.style.display = 'none';
	    */
        }
        return this.arrRewards;
    }

    setMasterKey(masterKey) {
	this.masterKey = masterKey;
	this.arrRewards = [];
    }

}

let _network = null;

/**
 * Sets the network in use by MPW.
 * @param {Network} network - network to use
 */
export function setNetwork(network) {
    _network = network;
}

/**
 * Sets the network in use by MPW.
 * @returns {Network?} Returns the network in use, may be null if MPW hasn't properly loaded yet.
 */
export function getNetwork() {
    return _network;
}

export let lastWallet = 0;

export function getFee(bytes) {
    // TEMPORARY: Hardcoded fee per-byte
    return bytes * 50; // 50 sat/byte
}

export async function getStakingRewards() {
    if (!networkEnabled || masterKey == undefined) return;
    doms.domGuiStakingLoadMoreIcon.style.opacity = 0.5;
    const stopAnim = () => (doms.domGuiStakingLoadMoreIcon.style.opacity = 1);
    const nHeight = arrRewards.length
        ? arrRewards[arrRewards.length - 1].blockHeight
        : 0;
    let mapPaths = new Map();
    const txSum = (v) =>
        v.reduce(
            (t, s) =>
                t +
                (s.addresses
                    .map((strAddr) => mapPaths.get(strAddr))
                    .filter((v) => v).length && s.addresses.length === 2
                    ? parseInt(s.value)
                    : 0),
            0
        );
    let cData;
    if (masterKey.isHD) {
        const derivationPath = getDerivationPath(masterKey.isHardwareWallet)
            .split('/')
            .slice(0, 4)
            .join('/');
        const xpub = await masterKey.getxpub(derivationPath);
        cData = await (
            await fetch(
                `${
                    cExplorer.url
                }/api/v2/xpub/${xpub}?details=txs&pageSize=500&to=${
                    nHeight ? nHeight - 1 : 0
                }`
            )
        ).json();
        // Map all address <--> derivation paths
        if (cData.tokens)
            cData.tokens.forEach((cAddrPath) =>
                mapPaths.set(cAddrPath.name, cAddrPath.path)
            );
    } else {
        const address = await masterKey.getAddress();
        cData = await (
            await fetch(
                `${
                    cExplorer.url
                }/api/v2/address/${address}?details=txs&pageSize=500&to=${
                    nHeight ? nHeight - 1 : 0
                }`
            )
        ).json();
        mapPaths.set(address, ':)');
    }
    if (cData && cData.transactions) {
        // Update rewards
        arrRewards = arrRewards.concat(
            cData.transactions
                .filter((tx) => tx.vout[0].addresses[0] === 'CoinStake TX')
                .map((tx) => {
                    return {
                        id: tx.txid,
                        time: tx.blockTime,
                        blockHeight: tx.blockHeight,
                        amount: (txSum(tx.vout) - txSum(tx.vin)) / COIN,
                    };
                })
                .filter((tx) => tx.amount != 0)
        );

        // If the results don't match the full 'max/requested results', then we know there's nothing more to load, hide the button!
        if (cData.transactions.length !== cData.itemsOnPage)
            doms.domGuiStakingLoadMore.style.display = 'none';

        // Update GUI
        stopAnim();
        updateStakingRewardsGUI(true);
    } else {
        // No balance history!
        doms.domGuiStakingLoadMore.style.display = 'none';

        // Update GUI
        stopAnim();
    }
}

||||||| parent of fa34b25 (Fleshed out the system a bit more)
export let lastWallet = 0;


export function getFee(bytes) {
    // TEMPORARY: Hardcoded fee per-byte
    return bytes * 50; // 50 sat/byte
}

export async function getStakingRewards() {
    if (!networkEnabled || masterKey == undefined) return;
    doms.domGuiStakingLoadMoreIcon.style.opacity = 0.5;
    const stopAnim = () => (doms.domGuiStakingLoadMoreIcon.style.opacity = 1);
    const nHeight = arrRewards.length
        ? arrRewards[arrRewards.length - 1].blockHeight
        : 0;
    let mapPaths = new Map();
    const txSum = (v) =>
        v.reduce(
            (t, s) =>
                t +
                (s.addresses
                    .map((strAddr) => mapPaths.get(strAddr))
                    .filter((v) => v).length && s.addresses.length === 2
                    ? parseInt(s.value)
                    : 0),
            0
        );
    let cData;
    if (masterKey.isHD) {
        const derivationPath = getDerivationPath(masterKey.isHardwareWallet)
            .split('/')
            .slice(0, 4)
            .join('/');
        const xpub = await masterKey.getxpub(derivationPath);
        cData = await (
            await fetch(
                `${
                    cExplorer.url
                }/api/v2/xpub/${xpub}?details=txs&pageSize=500&to=${
                    nHeight ? nHeight - 1 : 0
                }`
            )
        ).json();
        // Map all address <--> derivation paths
        if (cData.tokens)
            cData.tokens.forEach((cAddrPath) =>
                mapPaths.set(cAddrPath.name, cAddrPath.path)
            );
    } else {
        const address = await masterKey.getAddress();
        cData = await (
            await fetch(
                `${
                    cExplorer.url
                }/api/v2/address/${address}?details=txs&pageSize=500&to=${
                    nHeight ? nHeight - 1 : 0
                }`
            )
        ).json();
        mapPaths.set(address, ':)');
    }
    if (cData && cData.transactions) {
        // Update rewards
        arrRewards = arrRewards.concat(
            cData.transactions
                .filter((tx) => tx.vout[0].addresses[0] === 'CoinStake TX')
                .map((tx) => {
                    return {
                        id: tx.txid,
                        time: tx.blockTime,
                        blockHeight: tx.blockHeight,
                        amount: (txSum(tx.vout) - txSum(tx.vin)) / COIN,
                    };
                })
                .filter((tx) => tx.amount != 0)
        );

        // If the results don't match the full 'max/requested results', then we know there's nothing more to load, hide the button!
        if (cData.transactions.length !== cData.itemsOnPage)
            doms.domGuiStakingLoadMore.style.display = 'none';

        // Update GUI
        stopAnim();
        updateStakingRewardsGUI(true);
    } else {
        // No balance history!
        doms.domGuiStakingLoadMore.style.display = 'none';

        // Update GUI
        stopAnim();
    }
}

=======
/*
>>>>>>> fa34b25 (Fleshed out the system a bit more)
export async function getTxInfo(txHash) {
    const req = await fetch(`${cExplorer.url}/api/v2/tx/${txHash}`);
    return await req.json();
}

*/
