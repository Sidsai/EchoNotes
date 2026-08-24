/**
 * Build-time constants injected by esbuild's `define` (scripts/build.mjs).
 * `__E2E__` is true only when built with `--e2e`, gating the one behavior
 * change the E2E build makes: recognizing the fake-Meet test harness's
 * origin as a capturable "platform," which is never true for the manifest
 * actually shipped to users (see build.mjs's own comment on why).
 */
declare const __DEV__: boolean;
declare const __E2E__: boolean;
