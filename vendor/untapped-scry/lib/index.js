var binary = require('@mapbox/node-pre-gyp');
var path = require('path');
var binding_path = binary.find(path.resolve(path.join(__dirname,'../package.json')));
var scrylib = require(binding_path);

module.exports = {
    Scry: scrylib.Scry,
    DotNetCoreScry: scrylib.DotNetCoreScry,
    GodotScry: scrylib.GodotScry,
    Il2CppScry: scrylib.Il2CppScry,
    MonoScry: scrylib.MonoScry
};
