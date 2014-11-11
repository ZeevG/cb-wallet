"use strict";

var API = require('cb-blockr')
var bitcoin = require('bitcoinjs-lib')
var TxGraph = require('bitcoin-tx-graph')
var assert = require('assert')
var discoverAddresses = require('./network').discoverAddresses
var fetchTransactions = require('./network').fetchTransactions
var validate = require('./validator')

function Wallet(externalAccount, internalAccount, networkName, done) {
  if(arguments.length === 0) return this;

  try {
    if(typeof externalAccount === 'string') {
      this.externalAccount = bitcoin.HDNode.fromBase58(externalAccount)
    } else {
      this.externalAccount = externalAccount
    }

    if(typeof internalAccount === 'string') {
      this.internalAccount = bitcoin.HDNode.fromBase58(internalAccount)
    } else {
      this.internalAccount = internalAccount
    }

    assert(this.externalAccount != null, 'externalAccount cannot be null')
    assert(this.internalAccount != null, 'internalAccount cannot be null')
  } catch(e) {
    return done(e)
  }

  this.networkName = networkName
  this.api = new API(networkName)
  this.txGraph = new TxGraph()

  var that = this

  discoverAddresses(this.api, this.externalAccount, this.internalAccount, function(err, addresses, changeAddresses) {
    if(err) return done(err);

    that.addresses = addresses
    that.changeAddresses = changeAddresses

    var addresses = addresses.concat(changeAddresses)
    fetchTransactions(that.api, addresses, function(err, txs, metadata) {
      if(err) return done(err);

      txs.forEach(function(tx) { that.txGraph.addTx(tx) })

      var feesAndValues = that.txGraph.calculateFeesAndValues(addresses, bitcoin.networks[that.networkName])
      that.txMetadata = mergeMetadata(feesAndValues, metadata)

      done(null, that)
    })
  })
}

Wallet.prototype.getBalance = function(minConf) {
  minConf = minConf || 0

  var network = bitcoin.networks[this.networkName]
  var myAddresses = this.addresses.concat(this.changeAddresses)
  var utxos = getCandidateOutputs(this.txGraph.heads, this.txMetadata, network, myAddresses, minConf)

  return utxos.reduce(function(balance, unspent) {
    return balance + unspent.value
  }, 0)
}

Wallet.prototype.getNextChangeAddress = function() {
  return this.internalAccount.derive(this.changeAddresses.length).getAddress().toString()
}

Wallet.prototype.getNextAddress = function() {
  return this.externalAccount.derive(this.addresses.length).getAddress().toString()
}

Wallet.prototype.getPrivateKeyForAddress = function(address) {
  var index
  if((index = this.addresses.indexOf(address)) > -1) {
    return this.externalAccount.derive(index).privKey
  } else if((index = this.changeAddresses.indexOf(address)) > -1) {
    return this.internalAccount.derive(index).privKey
  } else {
    throw new Error('Unknown address. Make sure the address is from the keychain and has been generated.')
  }
}

// param: `txObj` or
// `[{tx: txObj1, confirmations: n1, timestamp: t1}, {tx: txObj2, confirmations: n2, timestamp: t2}]`
Wallet.prototype.processTx = function(txs) {
  if(!Array.isArray(txs)) {
    txs = [{tx: txs}]
  }

  var foundUsed = true
  while(foundUsed) {
    foundUsed = addToAddresses.bind(this)(this.getNextAddress(), this.getNextChangeAddress())
  }

  txs.forEach(function(obj) {
    var tx = obj.tx
    this.txGraph.addTx(tx)

    var id = tx.getId()
    this.txMetadata[id] = this.txMetadata[id] || { confirmations: null }
    if(obj.confirmations != null) {
      this.txMetadata[id].confirmations = obj.confirmations
    }
    if(obj.timestamp != null) {
      this.txMetadata[id].timestamp = obj.timestamp
    }
  }, this)

  //FIXME: make me more effecient
  var myAddresses = this.addresses.concat(this.changeAddresses)
  var feesAndValues = this.txGraph.calculateFeesAndValues(myAddresses, bitcoin.networks[this.networkName])
  this.txMetadata = mergeMetadata(feesAndValues, this.txMetadata)

  function addToAddresses(nextAddress, nextChangeAddress) {
    for(var i=0; i<txs.length; i++) {
      var tx = txs[i].tx
      var found = tx.outs.some(function(out){
        var address = bitcoin.Address.fromOutputScript(out.script, bitcoin.networks[this.networkName]).toString()
        if(nextChangeAddress === address) {
          this.changeAddresses.push(address)
          return true
        } else if(nextAddress === address) {
          this.addresses.push(address)
          return true
        }
      }, this)

      if(found) return true
    }
  }
}

Wallet.prototype.createTx = function(to, value, fee, minConf) {
  var network = bitcoin.networks[this.networkName]
  validate.preCreateTx(to, value, network)

  var myAddresses = this.addresses.concat(this.changeAddresses)
  if(minConf == null) minConf = 1
  var utxos = getCandidateOutputs(this.txGraph.heads, this.txMetadata, network, myAddresses, minConf)
  utxos = utxos.sort(function(o1, o2){
    return o2.value - o1.value
  })

  var accum = 0
  var subTotal = value
  var addresses = []

  var tx = new bitcoin.Transaction()
  tx.addOutput(to, value)

  var that = this
  utxos.some(function(unspent) {
    tx.addInput(unspent.id, unspent.index)
    addresses.push(unspent.address)

    var estimatedFee
    if(fee == undefined) {
      estimatedFee = estimateFeePadChangeOutput(tx, network)
    } else {
      estimatedFee = fee
    }

    accum += unspent.value
    subTotal = value + estimatedFee
    if (accum >= subTotal) {
      var change = accum - subTotal

      if (change > network.dustThreshold) {
        tx.addOutput(that.getNextChangeAddress(), change)
      }

      return true
    }
  })

  validate.postCreateTx(subTotal, accum, this.getBalance(0))

  addresses.forEach(function(address, i) {
    tx.sign(i, that.getPrivateKeyForAddress(address))
  })

  return tx
}

Wallet.prototype.sendTx = function(tx, done) {
  var that = this
  this.api.transactions.propagate(tx.toHex(), function(err){
    if(err) return done(err);

    that.processTx(tx)
    done()
  })
}

function getCandidateOutputs(headNodes, metadata, network, myAddresses, minConf) {
  var unspentNodes = headNodes.filter(function(n) {
    return metadata[n.id].confirmations >= minConf
  })

  return unspentNodes.reduce(function(unspentOutputs, node) {
    node.tx.outs.forEach(function(out, i) {
      var address = bitcoin.Address.fromOutputScript(out.script, network).toString()
      if(myAddresses.indexOf(address) >= 0) {
        unspentOutputs.push({
          id: node.id,
          address: address,
          value: out.value,
          index: i
        })
      }
    })

    return unspentOutputs
  }, [])
}

function estimateFeePadChangeOutput(tx, network) {
  var tmpTx = tx.clone()
  var tmpAddress = bitcoin.Address.fromOutputScript(tx.outs[0].script, network)
  tmpTx.addOutput(tmpAddress, network.dustSoftThreshold || 0)

  return network.estimateFee(tmpTx)
}

Wallet.prototype.getTransactionHistory = function() {
  var txGraph = this.txGraph
  var metadata = this.txMetadata

  var nodes = txGraph.getAllNodes().filter(function(n) {
    return n.tx != null && metadata[n.id].value != null
  }).sort(function(a, b) {
    var confDiff = metadata[a.id].confirmations - metadata[b.id].confirmations
    if(confDiff !== 0) {
      return confDiff
    }

    return txGraph.compareNodes(a, b)
  })

  return nodes.map(function(n) {
    return n.tx
  })
}

Wallet.prototype.serialize = function() {
  var txs = this.txGraph.getAllNodes().reduce(function(memo, node) {
    var tx = node.tx
    if(tx == null) return memo;

    memo.push(tx.toHex())
    return memo
  }, [])

  return {
    externalAccount: this.externalAccount.toBase58(),
    internalAccount: this.internalAccount.toBase58(),
    addressIndex: this.addresses.length,
    changeAddressIndex: this.changeAddresses.length,
    networkName: this.networkName,
    txs: txs,
    txMetadata: this.txMetadata
  }
}

Wallet.deserialize = function(obj) {
  var wallet = new Wallet()

  wallet.externalAccount = bitcoin.HDNode.fromBase58(obj.externalAccount)
  wallet.internalAccount = bitcoin.HDNode.fromBase58(obj.internalAccount)
  wallet.addresses = deriveAddresses(wallet.externalAccount, obj.addressIndex)
  wallet.changeAddresses = deriveAddresses(wallet.internalAccount, obj.changeAddressIndex)
  wallet.networkName = obj.networkName
  wallet.api = new API(obj.networkName)
  wallet.txMetadata = obj.txMetadata

  wallet.txGraph = new TxGraph()
  obj.txs.forEach(function(hex) {
    wallet.txGraph.addTx(bitcoin.Transaction.fromHex(hex))
  })

  return wallet
}


function mergeMetadata(feesAndValues, metadata) {
  for(var id in metadata) {
    var fee = feesAndValues[id].fee
    if(fee != null) metadata[id].fee = fee

    var value = feesAndValues[id].value
    if(value < 0) value += fee
    if(value != null) metadata[id].value = value
  }

  return metadata
}

function deriveAddresses(account, untilId) {
  var addresses = []
  for(var i=0; i<untilId; i++) {
    addresses.push(account.derive(i).getAddress().toString())
  }
  return addresses
}

module.exports = Wallet

