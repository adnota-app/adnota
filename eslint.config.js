// Deliberately minimal config — only rules that catch *bugs*, not style.
// No `eslint:recommended` extend because it bundles dozens of opinionated
// rules and the goal here is signal over coverage. Adding rules over time
// is fine; removing them after a noise wave is what we're avoiding.
//
// Globals list mirrors the window.X handshake surface declared across
// content scripts (see README "Shared Libraries"). Listed `writable`
// because each tool assigns its export on first run.

const adnotaGlobals = {
  // lib/
  AdnotaUI: 'writable', AdnotaState: 'writable', AdnotaLog: 'writable',
  AdnotaStorage: 'writable', AdnotaUndo: 'writable', AdnotaVisibility: 'writable',
  AdnotaLayout: 'writable', AdnotaTags: 'writable',
  // content/
  FuzzyAnchor: 'writable', StickyEngine: 'writable',
  AdnotaHighlighter: 'writable', AdnotaMarker: 'writable',
  AdnotaResizer: 'writable', AdnotaDock: 'writable',
  AdnotaScratchPad: 'writable',
  // module-managed rule maps
  AdnotaResizeRules: 'writable', AdnotaEraseRules: 'writable',
  AdnotaReorderRules: 'writable', AdnotaErasedElements: 'writable',
  // misc shared globals
  AdnotaCursor: 'writable',
  rebuildResizeStyleTag: 'writable', rebuildEraseStyleTag: 'writable',
};

module.exports = [
  {
    // Flat config defaults only ignore node_modules/; without this entry,
    // `npm run lint` after `npm run build` crawls dist/ and lints the
    // minified output (useless noise + likely errors).
    ignores: ['dist/**'],
  },
  {
    files: ['content/**/*.js', 'lib/**/*.js', 'popup/**/*.js', 'pages/**/*.js', 'background.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        // Browser
        window: 'readonly', document: 'readonly', navigator: 'readonly',
        location: 'readonly', console: 'readonly', performance: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
        fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
        Element: 'readonly', HTMLElement: 'readonly', Node: 'readonly',
        NodeFilter: 'readonly',
        Range: 'readonly', CSS: 'readonly', Highlight: 'readonly',
        MutationObserver: 'readonly', ResizeObserver: 'readonly',
        IntersectionObserver: 'readonly', getComputedStyle: 'readonly',
        DOMParser: 'readonly', XMLSerializer: 'readonly',
        crypto: 'readonly', btoa: 'readonly', atob: 'readonly',
        Image: 'readonly', SVGElement: 'readonly', Blob: 'readonly',
        EventTarget: 'readonly', Event: 'readonly', CustomEvent: 'readonly',
        KeyboardEvent: 'readonly', MouseEvent: 'readonly', PointerEvent: 'readonly',
        getSelection: 'readonly', Selection: 'readonly',
        EyeDropper: 'readonly',
        localStorage: 'readonly', sessionStorage: 'readonly', history: 'readonly',
        // Extension API
        chrome: 'readonly',
        // Service worker
        importScripts: 'readonly', self: 'readonly',
        // Adnota cross-script handshake
        ...adnotaGlobals,
      },
    },
    rules: {
      // ── Real-bug catchers (high signal, near-zero noise) ────────────
      'no-undef': 'error',              // typo'd variable / global
      // no-redeclare deliberately omitted: this codebase declares helpers
      // locally then assigns to window for cross-file consumption (e.g.,
      // `const AdnotaStorage = {...}; window.AdnotaStorage = AdnotaStorage`).
      // ESLint reads the local declaration as redeclaring the listed global.
      // Real var/function redeclaration is rare; not worth the false-positive
      // tax against the export pattern.
      'no-dupe-keys': 'error',          // { foo: 1, foo: 2 } in object literal
      'no-dupe-args': 'error',          // function(a, a) {}
      'no-dupe-else-if': 'error',       // if/else if checking same condition
      'no-unreachable': 'error',        // code after return / throw
      'no-cond-assign': 'error',        // if (x = 5) — almost always typo for ==
      'no-self-assign': 'error',        // x = x
      'no-self-compare': 'error',       // x === x
      'valid-typeof': 'error',          // typeof x === 'strnig'
      'use-isnan': 'error',             // x === NaN
      'no-invalid-regexp': 'error',     // syntactically broken regex
      'no-misleading-character-class': 'error',
      'no-sparse-arrays': 'error',      // [1, , 3]
      'no-unsafe-finally': 'error',     // return inside finally
      'no-unsafe-negation': 'error',    // !key in object
      'no-constant-binary-expression': 'error', // !x || y kind of typos
      'no-control-regex': 'error',
      'no-func-assign': 'error',
      'no-import-assign': 'error',
      'no-obj-calls': 'error',          // Math()
      'no-setter-return': 'error',
      'getter-return': 'error',

      // ── Warnings, not errors — flagged but don't block CI ───────────
      'no-unused-vars': ['warn', {
        args: 'none',                   // function args not checked at all —
                                        // event handlers often share signature
                                        // (handlePenMove(e) / handlePenUp(e))
                                        // and renaming the unused side to _e
                                        // is asymmetry-for-the-linter's-sake.
        varsIgnorePattern: '^_',        // const _unused intentionally
        caughtErrors: 'none',           // unused err/e in catch blocks ignored
                                        // (same reasoning as args).
      }],
      'no-empty': ['warn', { allowEmptyCatch: true }], // empty try/catch is intentional in this codebase
    },
  },
];
