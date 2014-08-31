/*!
 * json-patch-duplex.js 0.3.10
 * (c) 2013 Joachim Wester
 * MIT license
 */

interface Object {
  observe : any;
  deliverChangeRecords : any;
  unobserve : any;
}

module jsonpatch {


  var _objectKeys = (function() {
    if (Object.keys)
      return Object.keys;

    return function (o) { //IE8
      var keys = [];
      for (var i in o) {
        if (o.hasOwnProperty(i)) {
          keys.push(i);
        }
      }
      return keys;
    }
  })();

  function _equals(a, b) {
    switch (typeof a) {
      case 'undefined': //backward compatibility, but really I think we should return false
      case 'boolean':
      case 'string':
      case 'number':
        return a === b;
      case 'object':
        if (a === null)
          return b === null;
        if (_isArray(a)) {
          if (!_isArray(b) || a.length !== b.length)
            return false;

          for (var i = 0, l = a.length; i < l; i++)
            if (!_equals(a[i], b[i])) return false;

          return true;
        }

        var bKeys = _objectKeys(b);
        var bLength = bKeys.length;
        if (_objectKeys(a).length !== bLength)
          return false;

        for (var i = 0; i < bLength; i++)
          if (!_equals(a[i], b[i])) return false;

        return true;

      default:
        return false;

    }
  }

  /* We use a Javascript hash to store each 
     function. Each hash entry (property) uses
     the operation identifiers specified in rfc6902.
     In this way, we can map each patch operation 
     to its dedicated function in efficient way.
     */
     
  /* The operations applicable to an object */
  var objOps = {
    add: function (obj, key) {
      obj[key] = this.value;
      return true;
    },
    remove: function (obj, key) {
      delete obj[key];
      return true;
    },
    replace: function (obj, key) {
      obj[key] = this.value;
      return true;
    },
    move: function (obj, key, tree) {
      var temp:any = {op: "_get", path: this.from};
      apply(tree, [temp]);
      apply(tree, [
        {op: "remove", path: this.from}
      ]);
      apply(tree, [
        {op: "add", path: this.path, value: temp.value}
      ]);
      return true;
    },
    copy: function (obj, key, tree) {
      var temp:any = {op: "_get", path: this.from};
      apply(tree, [temp]);
      apply(tree, [
        {op: "add", path: this.path, value: temp.value}
      ]);
      return true;
    },
    test: function (obj, key) {
      return _equals(obj[key], this.value);
    },
    _get: function (obj, key) {
      this.value = obj[key];
    }
  };

  /* The operations applicable to an array. Many are the same as for the object */
  var arrOps = {
    add: function (arr, i) {
      arr.splice(i, 0, this.value);
      return true;
    },
    remove: function (arr, i) {
      arr.splice(i, 1);
      return true;
    },
    replace: function (arr, i) {
      arr[i] = this.value;
      return true;
    },
    move: objOps.move,
    copy: objOps.copy,
    test: objOps.test,
    _get: objOps._get
  };

  /* The operations applicable to object root. Many are the same as for the object */
  var rootOps = {
    add: function (obj) {
      for (var key in this.value) {
        if (this.value.hasOwnProperty(key)) {
          obj[key] = this.value[key];
        }
      }
      return true;
    },
    remove: function (obj) {
      for (var key in obj) {
        if (obj.hasOwnProperty(key)) {
          objOps.remove.call(this, obj, key);
        }
      }
      return true;
    },
    replace: function (obj) {
      apply(obj, [
        {op: "remove", path: this.path}
      ]);
      apply(obj, [
        {op: "add", path: this.path, value: this.value}
      ]);
      return true;
    },
    move: objOps.move,
    copy: objOps.copy,
    test: function (obj) {
      return (JSON.stringify(obj) === JSON.stringify(this.value));
    },
    _get: objOps._get
  };

  var observeOps = {
    add: function (patches:any[], path) {
      var patch = {
        op: "add",
        path: path + escapePathComponent(this.name),
        value: this.object[this.name]};
      patches.push(patch);
    },
    'delete': function (patches:any[], path) { //single quotes needed because 'delete' is a keyword in IE8
      var patch = {
        op: "remove",
        path: path + escapePathComponent(this.name)
      };
      patches.push(patch);
    },
    update: function (patches:any[], path) {
      var patch = {
        op: "replace",
        path: path + escapePathComponent(this.name),
        value: this.object[this.name]
      };
      patches.push(patch);
    }
  };

  function escapePathComponent (str) {
    if (str.indexOf('/') === -1 && str.indexOf('~') === -1) return str;
    return str.replace(/~/g, '~0').replace(/\//g, '~1');
  }

  function _getPathRecursive(root:Object, obj:Object):string {
    var found;
    for (var key in root) {
      if (root.hasOwnProperty(key)) {
        if (root[key] === obj) {
          return escapePathComponent(key) + '/';
        }
        else if (typeof root[key] === 'object') {
          found = _getPathRecursive(root[key], obj);
          if (found != '') {
            return escapePathComponent(key) + '/' + found;
          }
        }
      }
    }
    return '';
  }

  function getPath(root:Object, obj:Object):string {
    if (root === obj) {
      return '/';
    }
    var path = _getPathRecursive(root, obj);
    if (path === '') {
      throw new Error("Object not found in root");
    }
    return '/' + path;
  }

  var beforeDict = [];

  export var intervals;

  class Mirror {
    obj: any;
    observers = [];

    constructor(obj:any){
      this.obj = obj;
    }
  }

  class ObserverInfo {
    callback: any;
    observer: any;

    constructor(callback, observer){
      this.callback = callback;
      this.observer = observer;
    }
  }

  function getMirror(obj:any):any {
    for (var i = 0, ilen = beforeDict.length; i < ilen; i++) {
      if (beforeDict[i].obj === obj) {
        return beforeDict[i];
      }
    }
  }

  function getObserverFromMirror(mirror:any, callback):any {
    for (var j = 0, jlen = mirror.observers.length; j < jlen; j++) {
      if (mirror.observers[j].callback === callback) {
        return mirror.observers[j].observer;
      }
    }
  }

  function removeObserverFromMirror(mirror:any, observer):any {
    for (var j = 0, jlen = mirror.observers.length; j < jlen; j++) {
      if (mirror.observers[j].observer === observer) {
        mirror.observers.splice(j, 1);
        return;
      }
    }
  }

  export function unobserve(root, observer) {
    generate(observer);
    if(Object.observe) {
      _unobserve(observer, root);
    }
    else {
      clearTimeout(observer.next);
    }

    var mirror = getMirror(root);
    removeObserverFromMirror(mirror, observer);

  }

  export function observe(obj:any, callback):any {
    var patches = [];
    var root = obj;
    var observer;
    var mirror = getMirror(obj);

    if (!mirror) {
      mirror = new Mirror(obj);
      beforeDict.push(mirror);
    } else {
      observer = getObserverFromMirror(mirror, callback);
    }

    if(observer){
      return observer;
    }

    if (Object.observe) {
      observer = function (arr) {
        //This "refresh" is needed to begin observing new object properties
        _unobserve(observer, obj);
        _observe(observer, obj);

        var a = 0
          , alen = arr.length;
        while (a < alen) {
          if (
            !(arr[a].name === 'length' && _isArray(arr[a].object))
              && !(arr[a].name === '__Jasmine_been_here_before__')
            ) {
            var type = arr[a].type;

            //old record type names before 10/29/2013 (http://wiki.ecmascript.org/doku.php?id=harmony:observe)
            //this block can be removed when Chrome 33 stable is released
            switch(type) {
              case 'new':
                type = 'add';
                break;

              case 'deleted':
                type = 'delete';
                break;

              case 'updated':
                type = 'update';
                break;
            }

            observeOps[type].call(arr[a], patches, getPath(root, arr[a].object));
          }
          a++;
        }

        if (patches) {
          if (callback) {
            callback(patches);
          }
        }
        observer.patches = patches;
        patches = [];


      };
    } else {
      observer = {};

      mirror.value = JSON.parse(JSON.stringify(obj)); // Faster than ES5 clone - http://jsperf.com/deep-cloning-of-objects/5

      if (callback) {
        //callbacks.push(callback); this has no purpose
        observer.callback = callback;
        observer.next = null;
        var intervals = this.intervals || [100, 1000, 10000, 60000];
        if (intervals.push === void 0) {
          throw new Error("jsonpatch.intervals must be an array");
        }
        var currentInterval = 0;

        var dirtyCheck = function () {
          generate(observer);
        };
        var fastCheck = function () {
          clearTimeout(observer.next);
          observer.next = setTimeout(function () {
            dirtyCheck();
            currentInterval = 0;
            observer.next = setTimeout(slowCheck, intervals[currentInterval++]);
          }, 0);
        };
        var slowCheck = function () {
          dirtyCheck();
          if (currentInterval == intervals.length)
            currentInterval = intervals.length - 1;
          observer.next = setTimeout(slowCheck, intervals[currentInterval++]);
        };
        if (typeof window !== 'undefined') { //not Node
          if (window.addEventListener) { //standards
            window.addEventListener('mousedown', fastCheck);
            window.addEventListener('mouseup', fastCheck);
            window.addEventListener('keydown', fastCheck);
          }
          else { //IE8
            window.attachEvent('onmousedown', fastCheck);
            window.attachEvent('onmouseup', fastCheck);
            window.attachEvent('onkeydown', fastCheck);
          }
        }
        observer.next = setTimeout(slowCheck, intervals[currentInterval++]);
      }
    }
    observer.patches = patches;
    observer.object = obj;

    mirror.observers.push(new ObserverInfo(callback, observer));

    return _observe(observer, obj);
  }

  /// Listen to changes on an object tree, accumulate patches
  function _observe(observer:any, obj:any):any {
    if (Object.observe) {
      Object.observe(obj, observer);
      for (var key in obj) {
        if (obj.hasOwnProperty(key)) {
          var v:any = obj[key];
          if (v && typeof (v) === "object") {
            _observe(observer, v);
          }
        }
      }
    }
    return observer;
  }

  function _unobserve(observer:any, obj:any):any {
    if (Object.observe) {
      Object.unobserve(obj, observer);
      for (var key in obj) {
        if (obj.hasOwnProperty(key)) {
          var v:any = obj[key];
          if (v && typeof (v) === "object") {
            _unobserve(observer, v);
          }
        }
      }
    }
    return observer;
  }

  export function generate(observer) {
    if (Object.observe) {
      Object.deliverChangeRecords(observer);
    }
    else {
      var mirror;
      for (var i = 0, ilen = beforeDict.length; i < ilen; i++) {
        if (beforeDict[i].obj === observer.object) {
          mirror = beforeDict[i];
          break;
        }
      }
      _generate(mirror.value, observer.object, observer.patches, "");
    }
    var temp = observer.patches;
    if(temp.length > 0) {
      observer.patches = [];
      if(observer.callback) {
        observer.callback(temp);
      }
    }
    return temp;
  }

  // Dirty check if obj is different from mirror, generate patches and update mirror
  function _generate(mirror, obj, patches, path) {
    var newKeys = _objectKeys(obj);
    var oldKeys = _objectKeys(mirror);
    var changed = false;
    var deleted = false;

    //if ever "move" operation is implemented here, make sure this test runs OK: "should not generate the same patch twice (move)"

    for (var t = oldKeys.length - 1; t >= 0; t--) {
      var key = oldKeys[t];
      var oldVal = mirror[key];
      if (obj.hasOwnProperty(key)) {
        var newVal = obj[key];
        if (oldVal instanceof Object) {
          _generate(oldVal, newVal, patches, path + "/" + escapePathComponent(key));
        }
        else {
          if (oldVal != newVal) {
            changed = true;
            patches.push({op: "replace", path: path + "/" + escapePathComponent(key), value: newVal});
            mirror[key] = newVal;
          }
        }
      }
      else {
        patches.push({op: "remove", path: path + "/" + escapePathComponent(key)});
        delete mirror[key];
        deleted = true; // property has been deleted
      }
    }

    if (!deleted && newKeys.length == oldKeys.length) {
      return;
    }

    for (var t = 0; t < newKeys.length; t++) {
      var key = newKeys[t];
      if (!mirror.hasOwnProperty(key)) {
        patches.push({op: "add", path: path + "/" + escapePathComponent(key), value: obj[key]});
        mirror[key] = JSON.parse(JSON.stringify(obj[key]));
      }
    }
  }

  var _isArray;
  if (Array.isArray) { //standards; http://jsperf.com/isarray-shim/4
    _isArray = Array.isArray;
  }
  else { //IE8 shim
    _isArray = function (obj:any) {
      return obj.push && typeof obj.length === 'number';
    }
  }

  /// Apply a json-patch operation on an object tree
  export function apply(tree:any, patches:any[]):boolean {
    var result = false
        , p = 0
        , plen = patches.length
        , patch;
    while (p < plen) {
      patch = patches[p];
      p++;
      // Find the object
      var keys = patch.path.split('/');
      var obj = tree;
      var t = 1; //skip empty element - http://jsperf.com/to-shift-or-not-to-shift
      var len = keys.length;

      while (true) {
        if (_isArray(obj)) {
          var index = parseInt(keys[t], 10);
          t++;
          if (t >= len) {
            result = arrOps[patch.op].call(patch, obj, index, tree); // Apply patch
            break;
          }
          obj = obj[index];
        }
        else {
          var key = keys[t];
          if(key) {
            if (key && key.indexOf('~') != -1)
              key = key.replace(/~1/g, '/').replace(/~0/g, '~'); // escape chars
            t++;
            if (t >= len) {
              result = objOps[patch.op].call(patch, obj, key, tree); // Apply patch
              break;
            }
          }
          else { //is root
            t++;
            if (t >= len) {
              result = rootOps[patch.op].call(patch, obj, key, tree); // Apply patch
              break;
            }
          }
          obj = obj[key];
        }
      }
    }
    return result;
  }

  export function compare(tree1:any, tree2:any):any[] {
    var patches = [];
    _generate(tree1, tree2, patches, '');
    return patches;
  }

  export function validate(patch:any[], multiple:boolean = false) {
    // document is an array
    if(!_isArray(patch))
      return [{error: 'INVALID_PATCH_TYPE'}];

    var errors = [];

    for (var i = 0; i < patch.length; i++) {
      var obj = patch[i];
      var error = '';

      //operation is an object
      if(typeof obj !== 'object' || obj === null || obj === undefined || _isArray(obj))
        error = 'INVALID_OPERATION_TYPE';

      //operation.op is valid
      else if (['add', 'remove', 'replace', 'move', 'copy', 'test'].indexOf(obj.op) < 0)
        error = 'INVALID_OP_VALUE';

      //operation.path is a string
      else if(typeof obj.path !== 'string')
        error = 'INVALID_PATH_TYPE';

      //operation.from is a string for move and copy operations
      else if ((obj.op === 'move' || obj.op === 'copy') && typeof obj.from !== 'string')
        error = 'INVALID_FROM_TYPE';

      //operation.value is present for add, replace and test operations
      else if (['add', 'replace', 'test'].indexOf(obj.op) > -1 && obj.value === undefined)
        error = 'INVALID_VALUE_TYPE';

      if (error) {
        errors.push({index: i, error: error});
        if (!multiple)
          break;
      }

    }
    return errors;
  }
}

declare var exports:any;

if (typeof exports !== "undefined") {
  exports.apply = jsonpatch.apply;
  exports.observe = jsonpatch.observe;
  exports.unobserve = jsonpatch.unobserve;
  exports.generate = jsonpatch.generate;
  exports.compare = jsonpatch.compare;
  exports.validate = jsonpatch.validate;
}
