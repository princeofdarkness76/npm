// XXX lib/utils/tar.js and this file need to be rewritten.

// URL-to-cache folder mapping:
// : -> !
// @ -> _
// http://registry.npmjs.org/foo/version -> cache/http!/...
//

/*
fetching a URL:
1. Check for URL in inflight URLs.  If present, add cb, and return.
2. Acquire lock at {cache}/{sha(url)}.lock
   retries = {cache-lock-retries, def=10}
   stale = {cache-lock-stale, def=60000}
   wait = {cache-lock-wait, def=10000}
3. if lock can't be acquired, then fail
4. fetch url, clear lock, call cbs

cache folders:
1. urls: http!/server.com/path/to/thing
2. c:\path\to\thing: file!/c!/path/to/thing
3. /path/to/thing: file!/path/to/thing
4. git@ private: git_github.com!npm/npm
5. git://public: git!/github.com/npm/npm
6. git+blah:// git-blah!/server.com/foo/bar

adding a folder:
1. tar into tmp/random/package.tgz
2. untar into tmp/random/contents/package, stripping one dir piece
3. tar tmp/random/contents/package to cache/n/v/package.tgz
4. untar cache/n/v/package.tgz into cache/n/v/package
5. rm tmp/random

Adding a url:
1. fetch to tmp/random/package.tgz
2. goto folder(2)

adding a name@version:
1. registry.get(name/version)
2. if response isn't 304, add url(dist.tarball)

adding a name@range:
1. registry.get(name)
2. Find a version that satisfies
3. add name@version

adding a local tarball:
1. untar to tmp/random/{blah}
2. goto folder(2)

adding a namespaced package:
1. lookup registry for @namespace
2. namespace_registry.get('name')
3. add url(namespace/latest.tarball)
*/

exports = module.exports = cache

cache.unpack = unpack
cache.clean = clean
cache.read = read

var npm = require('./npm.js')
var fs = require('graceful-fs')
var writeFileAtomic = require('write-file-atomic')
var assert = require('assert')
var rm = require('./utils/gently-rm.js')
var readJson = require('read-package-json')
var log = require('npmlog')
var path = require('path')
var asyncMap = require('slide').asyncMap
var tar = require('./utils/tar.js')
var fileCompletion = require('./utils/completion/file-completion.js')
var deprCheck = require('./utils/depr-check.js')
var addNamed = require('./cache/add-named.js')
var addLocal = require('./cache/add-local.js')
var addRemoteTarball = require('./cache/add-remote-tarball.js')
var addRemoteGit = require('./cache/add-remote-git.js')
var inflight = require('inflight')
var realizePackageSpecifier = require('realize-package-specifier')
var npa = require('npm-package-arg')
var getStat = require('./cache/get-stat.js')
var cachedPackageRoot = require('./cache/cached-package-root.js')
var mapToRegistry = require('./utils/map-to-registry.js')

cache.usage = 'npm cache add <tarball file>' +
              '\nnpm cache add <folder>' +
              '\nnpm cache add <tarball url>' +
              '\nnpm cache add <git url>' +
              '\nnpm cache add <name>@<version>' +
              '\nnpm cache ls [<path>]' +
              '\nnpm cache clean [<pkg>[@<version>]]'

cache.completion = function (opts, cb) {
  var argv = opts.conf.argv.remain
  if (argv.length === 2) {
    return cb(null, ['add', 'ls', 'clean'])
  }

  switch (argv[2]) {
    case 'clean':
    case 'ls':
      // cache and ls are easy, because the completion is
      // what ls_ returns anyway.
      // just get the partial words, minus the last path part
      var p = path.dirname(opts.partialWords.slice(3).join('/'))
      if (p === '.') p = ''
      return ls_(p, 2, cb)
    case 'add':
      // Same semantics as install and publish.
      return npm.commands.install.completion(opts, cb)
  }
}

function cache (args, cb) {
  var cmd = args.shift()
  switch (cmd) {
    case 'rm': case 'clear': case 'clean': return clean(args, cb)
    case 'list': case 'sl': case 'ls': return ls(args, cb)
    case 'add': return add(args, npm.prefix, cb)
    default: return cb('Usage: ' + cache.usage)
  }
}

// if the pkg and ver are in the cache, then
// just do a readJson and return.
// if they're not, then fetch them from the registry.
function read (name, ver, forceBypass, cb) {
  assert(typeof name === 'string', 'must include name of module to install')
  assert(typeof cb === 'function', 'must include callback')

  if (forceBypass === undefined || forceBypass === null) forceBypass = true

  var root = cachedPackageRoot({name: name, version: ver})
  function c (er, data) {
    if (er) log.verbose('cache', 'addNamed error for', name + '@' + ver, er)
    if (data) deprCheck(data)

    return cb(er, data)
  }

  if (forceBypass && npm.config.get('force')) {
    log.verbose('using force', 'skipping cache')
    return addNamed(name, ver, null, c)
  }

  readJson(path.join(root, 'package', 'package.json'), function (er, data) {
    if (er && er.code !== 'ENOENT' && er.code !== 'ENOTDIR') return cb(er)

    if (data) {
      if (!data.name) return cb(new Error('No name provided'))
      if (!data.version) return cb(new Error('No version provided'))
    }

    if (er) return addNamed(name, ver, null, c)
    else c(er, data)
  })
}

function normalize (args) {
  var normalized = ''
  if (args.length > 0) {
    var a = npa(args[0])
    if (a.name) normalized = a.name
    if (a.rawSpec) normalized = [normalized, a.rawSpec].join('/')
    if (args.length > 1) normalized = [normalized].concat(args.slice(1)).join('/')
  }

  if (normalized.substr(-1) === '/') {
    normalized = normalized.substr(0, normalized.length - 1)
  }
  normalized = path.normalize(normalized)
  log.silly('ls', 'normalized', normalized)

  return normalized
}

// npm cache ls [<path>]
function ls (args, cb) {
  var prefix = npm.config.get('cache')
  if (prefix.indexOf(process.env.HOME) === 0) {
    prefix = '~' + prefix.substr(process.env.HOME.length)
  }
  ls_(normalize(args), npm.config.get('depth'), function (er, files) {
    console.log(files.map(function (f) {
      return path.join(prefix, f)
    }).join('\n').trim())
    cb(er, files)
  })
}

// Calls cb with list of cached pkgs matching show.
function ls_ (req, depth, cb) {
  return fileCompletion(npm.cache, req, depth, cb)
}

// npm cache clean [<path>]
function clean (args, cb) {
  assert(typeof cb === 'function', 'must include callback')

  if (!args) args = []

  var f = path.join(npm.cache, normalize(args))
  if (f === npm.cache) {
    fs.readdir(npm.cache, function (er, files) {
      if (er) return cb()
      asyncMap(
        files.filter(function (f) {
          return npm.config.get('force') || f !== '-'
        }).map(function (f) {
          return path.join(npm.cache, f)
        }),
        rm,
        cb
      )
    })
  } else {
    rm(f, cb)
  }
}

// npm cache add <tarball-url>
// npm cache add <pkg> <ver>
// npm cache add <tarball>
// npm cache add <folder>
cache.add = function (pkg, ver, where, scrub, cb) {
  assert(typeof pkg === 'string', 'must include name of package to install')
  assert(typeof cb === 'function', 'must include callback')

  if (scrub) {
    return clean([], function (er) {
      if (er) return cb(er)
      add([pkg, ver], where, cb)
    })
  }
  return add([pkg, ver], where, cb)
}

var adding = 0
function add (args, where, cb) {
  // this is hot code.  almost everything passes through here.
  // the args can be any of:
  // ['url']
  // ['pkg', 'version']
  // ['pkg@version']
  // ['pkg', 'url']
  // This is tricky, because urls can contain @
  // Also, in some cases we get [name, null] rather
  // that just a single argument.

  var usage = 'Usage:\n' +
              '    npm cache add <tarball-url>\n' +
              '    npm cache add <pkg>@<ver>\n' +
              '    npm cache add <tarball>\n' +
              '    npm cache add <folder>\n'
  var spec

  log.silly('cache add', 'args', args)

  if (args[1] === undefined) args[1] = null

  // at this point the args length must ==2
  if (args[1] !== null) {
    spec = args[0] + '@' + args[1]
  } else if (args.length === 2) {
    spec = args[0]
  }

  log.verbose('cache add', 'spec', spec)

  if (!spec) return cb(usage)

  adding++
  cb = afterAdd(cb)

  realizePackageSpecifier(spec, where, function (err, p) {
    if (err) return cb(err)

    log.silly('cache add', 'parsed spec', p)

    switch (p.type) {
      case 'local':
      case 'directory':
        addLocal(p, null, cb)
        break
      case 'remote':
        // get auth, if possible
        mapToRegistry(spec, npm.config, function (err, uri, auth) {
          if (err) return cb(err)

          addRemoteTarball(p.spec, { name: p.name }, null, auth, cb)
        })
        break
      case 'git':
      case 'hosted':
        addRemoteGit(p.rawSpec, cb)
        break
      default:
        if (p.name) return addNamed(p.name, p.spec, null, cb)

        cb(new Error("couldn't figure out how to install " + spec))
    }
  })
}

function unpack (pkg, ver, unpackTarget, dMode, fMode, uid, gid, cb) {
  if (typeof cb !== 'function') {
    cb = gid
    gid = null
  }
  if (typeof cb !== 'function') {
    cb = uid
    uid = null
  }
  if (typeof cb !== 'function') {
    cb = fMode
    fMode = null
  }
  if (typeof cb !== 'function') {
    cb = dMode
    dMode = null
  }

  read(pkg, ver, false, function (er) {
    if (er) {
      log.error('unpack', 'Could not read data for %s', pkg + '@' + ver)
      return cb(er)
    }
    npm.commands.unbuild([unpackTarget], true, function (er) {
      if (er) return cb(er)
      tar.unpack(
        path.join(cachedPackageRoot({ name: pkg, version: ver }), 'package.tgz'),
        unpackTarget,
        dMode, fMode,
        uid, gid,
        cb
      )
    })
  })
}

function afterAdd (cb) {
  return function (er, data) {
    adding--

    if (er || !data || !data.name || !data.version) return cb(er, data)
    log.silly('cache', 'afterAdd', data.name + '@' + data.version)

<<<<<<< HEAD
var publishEverythingWarning = {}
function packTar (targetTarball, folder, pkg, cb) {
  if (folder.charAt(0) !== "/") folder = path.join(process.cwd(), folder)
  if (folder.slice(-1) === "/") folder = folder.slice(0, -1)
  if (typeof pkg === "function") {
    cb = pkg, pkg = null
    return readJson(path.join(folder, "package.json"), function (er, pkg) {
      if (er) return log.er(cb, "Couldn't find package.json in "+folder)(er)
      packTar(targetTarball, folder, pkg, cb)
    })
  }
  log.verbose(folder+" "+targetTarball, "packTar")
  var parent = path.dirname(folder)
    , addFolder = path.basename(folder)
    , ignore = path.join(folder, ".npmignore")
    , defaultIgnore = path.join(__dirname, "utils", "default.npmignore")
    , customIgnore = false

  cb = log.er(cb, "Failed creating the tarball.\n"
             + "This is very rare. Perhaps the 'gzip' or 'tar' configs\n"
             + "are set improperly?\n")

  fs.stat(ignore, function (er) {
    if (er) ignore = defaultIgnore
    else customIgnore = true
    mkdir(path.dirname(targetTarball), function (er) {
      if (er) return log.er(cb, "Could not create "+targetTarball)(er)
      // tar xf - --strip-components=1 -C {unpackTarget} \
      //   | gzip {tarball} > targetTarball
      var target = fs.createWriteStream(targetTarball)
        , unPacked = false
        , args = [ "-cvf", "-", "--exclude", ".git", "-X", ignore]
        , tarEnv = {}
      for (var i in process.env) {
        tarEnv[i] = process.env[i]
      }
      // Sometimes you make it hard to love you, OS X.
      tarEnv.COPY_EXTENDED_ATTRIBUTES_DISABLE = "true"
      tarEnv.COPYFILE_DISABLE = "true"
      if (!pkg.files
          && !publishEverythingWarning[pkg._id]
          && !customIgnore) {
        publishEverythingWarning[pkg._id] = true
        log.warn("Adding entire directory to tarball. Please add a\n"
                +".npmignore or specify a 'files' array in the package.json"
                ,"publish-everything "+pkg._id)
      }
      if (!pkg.files) pkg.files = [""]
      args.push.apply(args, pkg.files.map(function (f) {
        // the second path.join is to prevent escapes.
        return path.join(addFolder, path.join("/", f))
      }))
      var tar = spawn(npm.config.get("tar"), args, tarEnv, false, parent)
        , gzip = spawn( npm.config.get("gzipbin"), ["--stdout"]
                      , null, false, parent )
        , errState
      pipe(tar, gzip, function (er) {
        if (errState) return
        if (er) return cb(errState = er)
      })
      sys.pump(gzip.stdout, target)
      target.on("close", function (er, ok) {
        if (errState) return
        if (er) return cb(errState = er)
        fs.chmod(targetTarball, 0644, function (er) {
          if (errState) return
          return cb(errState = er)
        })
=======
    // Save the resolved, shasum, etc. into the data so that the next
    // time we load from this cached data, we have all the same info.
    var pj = path.join(cachedPackageRoot(data), 'package', 'package.json')

    var done = inflight(pj, cb)
    if (!done) return log.verbose('afterAdd', pj, 'already in flight; not writing')
    log.verbose('afterAdd', pj, 'not in flight; writing')

    getStat(function (er, cs) {
      if (er) return done(er)
      writeFileAtomic(pj, JSON.stringify(data), { chown: cs }, function (er) {
        if (!er) log.verbose('afterAdd', pj, 'written')
        return done(er, data)
>>>>>>> npm/master
      })
    })
  }
}
