module.exports = WebConn

var BitField = require('bitfield')
var debug = require('debug')('bittorrent-swarm:webconn')
var get = require('simple-get')
var inherits = require('inherits')
var Wire = require('bittorrent-protocol')
var async = require('async')

inherits(WebConn, Wire)

/**
 * Converts requests for torrent blocks into http range requests.
 * @param {string} url web seed url
 * @param {Object} parsedTorrent
 */
function WebConn (url, parsedTorrent) {
  var self = this
  Wire.call(this)

  self.url = url
  self.parsedTorrent = parsedTorrent

  self.setKeepAlive(true)

  self.on('handshake', function (infoHash, peerId) {
    self.handshake(infoHash, new Buffer(20).fill(url))
    var numPieces = self.parsedTorrent.pieces.length
    var bitfield = new BitField(numPieces)
    for (var i = 0; i <= numPieces; i++) {
      bitfield.set(i, true)
    }
    self.bitfield(bitfield)
  })

  self.on('choke', function () { debug('choke') })
  self.on('unchoke', function () { debug('unchoke') })

  self.once('interested', function () {
    debug('interested')
    self.unchoke()
  })
  self.on('uninterested', function () { debug('uninterested') })

  self.on('bitfield', function () { debug('bitfield') })

  self.on('request', function (pieceIndex, offset, length, callback) {
    debug('request pieceIndex=%d offset=%d length=%d', pieceIndex, offset, length)
    self.httpRequest(pieceIndex, offset, length, callback)
  })
}

WebConn.prototype.httpRequest = function (pieceIndex, offset, length, cb) {
  var self = this
  var pieceOffset = pieceIndex * self.parsedTorrent.pieceLength
  var start = pieceOffset + offset
  var end = start + length - 1
  var requestUrl = self.url
  var requests = []
  var opts = {}
  debug('Requesting pieceIndex=%d offset=%d length=%d start=%d end=%d', pieceIndex, offset, length, start, end)
  if (self.parsedTorrent.files.length > 1) {
    for (var i = 0; i < self.parsedTorrent.files.length; i++) {
      var file = self.parsedTorrent.files[i]
      if (start < (file.offset + file.length)) {
        if (start >= file.offset) {
          if (end > (file.offset + file.length)) {
            var requestEnd = file.offset + file.length - 1
          } else {
            requestEnd = end
          }
          if (self.url.length > 0 && self.url.substring(self.url.length - 1, self.url.length) === '/') {
            requestUrl = self.url + encodeURI(file.path)
          } else if (self.url.indexOf(encodeURI(file.name)) === -1) {
            debug('no webseed provided for file' + file.path)
            return cb(new Error('no webseed provided for requesting file'))
          }
          opts = {
            url: requestUrl,
            method: 'GET',
            headers: {
              'user-agent': 'WebTorrent (http://webtorrent.io)',
              'range': 'bytes=' + (start - file.offset) + '-' + (requestEnd - file.offset)
            }
          }
          requests.push(opts)
          debug(start + '-' + requestEnd + ' in file[' + i + '] ' + file.path)
          start = file.offset + file.length
          if (end <= start) {
            break
          }
        }
      }
    }
  } else {
    opts = {
      url: requestUrl,
      method: 'GET',
      headers: {
        'user-agent': 'WebTorrent (http://webtorrent.io)',
        'range': 'bytes=' + start + '-' + end
      }
    }
    requests.push(opts)
  }
  async.mapLimit(requests, 1, function (opt, callback) {
    get.concat(opt, function (err, data, res) {
      if (err) return callback(err)
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return callback(new Error('Unexpected HTTP status code ' + res.statusCode))
      }
      callback(null, data)
    })
  }, function (err, results) {
    if (err) {
      debug('got error')
      return cb(err)
    }
    if (results && results.length > 0) {
      var result = results[0]
      for (var i = 1; i < results.length; i++) {
        result = Buffer.concat([result, results[i]])
      }
      cb(null, result)
    } else {
      cb(new Error('Unknown Error'))
    }
  })
}
