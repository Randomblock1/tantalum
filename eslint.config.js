import js from "@eslint/js";
import globals from "globals";

const browserGlobals = { ...globals.browser };

const legacyShared = {
    languageOptions: {
        ecmaVersion: 2022,
        sourceType: "script",
        globals: {
            ...browserGlobals,
            tcore: "readonly",
            tui: "readonly",
            tgl: "readonly",
            Shaders: "readonly",
            GasDischargeLines: "readonly",
        },
    },
    rules: {
        "no-redeclare": "off",
        "no-unused-vars": "off",
        "no-cond-assign": "off",
        "no-empty": "off",
    },
};

export default [
    { ignores: ["dist/**", "node_modules/**", "src/tantalum-shaders.js"] },
    js.configs.recommended,
    {
        files: ["src/main.js", "src/backend/**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            globals: browserGlobals,
        },
        rules: {
            "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
        },
    },
    {
        files: ["src/download.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "script",
            globals: browserGlobals,
        },
    },
    {
        files: [
            "src/tantalum-core.js",
            "src/tantalum-gl.js",
            "src/tantalum-ui.js",
            "src/tantalum.js",
            "src/bootstrap.js",
            "src/spectrum.js",
            "src/gasspectra.js",
        ],
        ...legacyShared,
    },
    {
        files: ["vite.config.js", "eslint.config.js", "playwright.config.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            globals: { ...globals.node },
        },
    },
    {
        files: ["tests/**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            globals: { ...globals.node, ...browserGlobals },
        },
    },
];
