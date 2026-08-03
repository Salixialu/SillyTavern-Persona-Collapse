global.window = {};
global.document = {
  querySelectorAll: () => [],
  querySelector: () => null,
  getElementById: () => null,
  createElement: () => ({ style: {} }),
  head: { appendChild: () => {} },
  body: { appendChild: () => {} }
};
global.jQuery = function(cb) { cb(); };
global.MutationObserver = class { observe() {} disconnect() {} };
global.localStorage = { getItem: () => null, setItem: () => {} };

const fs = require('fs');
let code = fs.readFileSync('dist/index.js', 'utf8');

// Mock ST imports by replacing the import statements
code = code.replace(/import\s*\{[^}]+\}\s*from\s*['"][^'"]+['"];/g, '');

// Provide mocked global equivalents for what we removed
global.t = {}; // extension_settings
global.e = { on: () => {} }; // eventSource
global.n = { APP_READY: 'APP_READY' }; // event_types
global.s = () => {}; // saveSettingsDebounced
global.a = { personas: {}, persona_descriptions: {} }; // power_user
global.i = {}; // POPUP_TYPE
global.r = class {}; // Popup

eval(code);
console.log("Mock Eval Success!");
