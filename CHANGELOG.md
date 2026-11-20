# Changelog

## [2.4.1](https://github.com/chrischall/opencode-copilot-plugin/compare/v2.4.0...v2.4.1) (2026-11-20)


### Bug Fixes

* **deps:** Bump the production-dependencies group with 2 updates ([0ab9399](https://github.com/chrischall/opencode-copilot-plugin/commit/0ab9399bf15271fcf222078fe4e7409dfe666936))

## [2.4.0](https://github.com/chrischall/opencode-copilot-plugin/compare/v2.3.0...v2.4.0) (2026-11-19)


### Features

* **models:** add GPT-6, Astra, Claude Opus, Sonnet 5/5.5 and Fable, with premium access and a cost table ([#124](https://github.com/chrischall/opencode-copilot-plugin/issues/124)) ([1c4c8e8](https://github.com/chrischall/opencode-copilot-plugin/commit/1c4c8e81cbc61b01cd835bdbaa9e163e0b3bb097))
* **ui:** show context usage, M365 message quota and allowances in opencode's meter, footer and sidebar ([#125](https://github.com/chrischall/opencode-copilot-plugin/issues/125)) ([18d00f0](https://github.com/chrischall/opencode-copilot-plugin/commit/18d00f0f357118e8879042d9830da2ec4ae01f43))


### Bug Fixes

* **models:** list GPT-5.5's reasoning tone once, folding think-deeper into an alias ([#123](https://github.com/chrischall/opencode-copilot-plugin/issues/123)) ([3979c6d](https://github.com/chrischall/opencode-copilot-plugin/commit/3979c6db98b234d8fa78ec444237febf8eae9aed))
* **models:** list one entry per GPT chat tone, folding gpt-5.5, gpt-5.5-quick and gpt-5.6 into aliases ([#121](https://github.com/chrischall/opencode-copilot-plugin/issues/121)) ([df2b49c](https://github.com/chrischall/opencode-copilot-plugin/commit/df2b49cc309c1d2f8ef2a73c43d6c4cf288e4214))


### Documentation

* put toolRouteFor's routing notes back on the function, and say plainly what mcpProxy off means ([#126](https://github.com/chrischall/opencode-copilot-plugin/issues/126)) ([974b559](https://github.com/chrischall/opencode-copilot-plugin/commit/974b559780021d44315c3044615b8e390f64e39f))

## [2.3.0](https://github.com/chrischall/opencode-copilot-plugin/compare/v2.2.1...v2.3.0) (2026-11-19)


### Features

* **mcp:** let the model find and call your MCP tools through one opt-in search tool ([#109](https://github.com/chrischall/opencode-copilot-plugin/issues/109)) ([426b851](https://github.com/chrischall/opencode-copilot-plugin/commit/426b8514f7b13d503ad923369705bb6795371faa))
* **mcp:** reach opencode's Code Mode MCP tools only through the opt-in mcpProxy tool ([#112](https://github.com/chrischall/opencode-copilot-plugin/issues/112)) ([c180e57](https://github.com/chrischall/opencode-copilot-plugin/commit/c180e57f200d4eaeae7128bcd8e6779d1a8ab530))
* **mcp:** summarise the MCP tools behind the search, by server, in the mcp tool's description ([#111](https://github.com/chrischall/opencode-copilot-plugin/issues/111)) ([52e16d1](https://github.com/chrischall/opencode-copilot-plugin/commit/52e16d1d85f7e5c5d541c559e5c63f6bb0075597))
* **models:** add GPT-6 Sol (6, 6.1 and 6.2), agent-less on tool turns ([#118](https://github.com/chrischall/opencode-copilot-plugin/issues/118)) ([4994764](https://github.com/chrischall/opencode-copilot-plugin/commit/4994764f0e64b5f3d69933a04e39f3b4a71bc81c))


### Bug Fixes

* **models:** list each M365 model once in the picker, and keep accepting the old short ids ([#116](https://github.com/chrischall/opencode-copilot-plugin/issues/116)) ([c24083a](https://github.com/chrischall/opencode-copilot-plugin/commit/c24083a835c28b0688d37e3b421272ae1cbdb450))
* **plugin:** list each model once when the plugin is loaded twice ([#115](https://github.com/chrischall/opencode-copilot-plugin/issues/115)) ([39b2d3e](https://github.com/chrischall/opencode-copilot-plugin/commit/39b2d3e2bb5e08dfff42d8c924963a0a622d374a))
* **tools:** run a tool block whose fence M365 opened at the end of a sentence ([#114](https://github.com/chrischall/opencode-copilot-plugin/issues/114)) ([8143073](https://github.com/chrischall/opencode-copilot-plugin/commit/81430733fc2e31a5337275f88c78262fbd2b2355))


### Documentation

* **config:** describe mcpProxy as the Code Mode search-and-call tool it is ([#117](https://github.com/chrischall/opencode-copilot-plugin/issues/117)) ([8c5637f](https://github.com/chrischall/opencode-copilot-plugin/commit/8c5637f49e6140edda1379814c9f1de303516a01))

## [2.2.1](https://github.com/chrischall/opencode-copilot-plugin/compare/v2.2.0...v2.2.1) (2026-11-10)


### Bug Fixes

* **prompt:** keep the user's own rules when trimming text about dropped tools ([#102](https://github.com/chrischall/opencode-copilot-plugin/issues/102)) ([92d1d6f](https://github.com/chrischall/opencode-copilot-plugin/commit/92d1d6f29821551a03684f5f4b9d1b50814fef9d))
* **server:** the refusal error code `m365_unavailable` is now `m365_not_served`, and every M365 refusal (`m365_throttled`, `m365_not_served`, `m365_turn_rejected`, `m365_disengaged`) now has `error.type` `invalid_request_error` instead of repeating its code. Clients matching `m365_unavailable`, or reading the code from `error.type`, must match `m365_not_served` and read `error.code` ([c843a5e](https://github.com/chrischall/opencode-copilot-plugin/commit/c843a5e082a47d837e714b5a58ac00047f9dd433))
* **tools:** recover from a disengage and tell the model which calls ran ([#104](https://github.com/chrischall/opencode-copilot-plugin/issues/104)) ([db88de2](https://github.com/chrischall/opencode-copilot-plugin/commit/db88de2047f2655d8828f38d03d61194bf675768))
* **tools:** stop opencode retrying M365 refusals and get think-deeper calling tools ([c843a5e](https://github.com/chrischall/opencode-copilot-plugin/commit/c843a5e082a47d837e714b5a58ac00047f9dd433))

## [2.2.0](https://github.com/chrischall/opencode-copilot-plugin/compare/v2.1.2...v2.2.0) (2026-11-09)


### Features

* **models:** work on live M365 tenants, default to quick, add doctor --live ([63ae0cf](https://github.com/chrischall/opencode-copilot-plugin/commit/63ae0cf5d0df8a883dac36300d6919e61830ca32))


### Bug Fixes

* **server:** return HTTP 422 instead of 502 for a rejected or disengaged turn, so opencode no longer retries it. Clients matching 502 (or `upstream_error`) for these must now match 422 with `m365_turn_rejected` or `m365_disengaged` ([63ae0cf](https://github.com/chrischall/opencode-copilot-plugin/commit/63ae0cf5d0df8a883dac36300d6919e61830ca32))
* **tools:** accept the tool-call shapes M365 writes and surface its refusals ([#100](https://github.com/chrischall/opencode-copilot-plugin/issues/100)) ([e8ac82a](https://github.com/chrischall/opencode-copilot-plugin/commit/e8ac82aff795e118ff8540e80a2886eadf7a7962))
* **tools:** keep opencode 2's shell tool in the lean toolset ([#99](https://github.com/chrischall/opencode-copilot-plugin/issues/99)) ([6ff3ba4](https://github.com/chrischall/opencode-copilot-plugin/commit/6ff3ba4d69feedd2422bf3e39eb1879251e60e8e))
* **tools:** stop contradicting opencode's tools, nudge give-ups, and pin the backend ([#101](https://github.com/chrischall/opencode-copilot-plugin/issues/101)) ([e7057f5](https://github.com/chrischall/opencode-copilot-plugin/commit/e7057f5b4cf77427798e904aa71f0d56e695e39a))

## [2.1.2](https://github.com/chrischall/opencode-copilot-plugin/compare/v2.1.1...v2.1.2) (2026-11-09)


### Bug Fixes

* **models:** label models by purpose in the picker ([#92](https://github.com/chrischall/opencode-copilot-plugin/issues/92)) ([34748a5](https://github.com/chrischall/opencode-copilot-plugin/commit/34748a5ff76f56904189ab98b697e41c294cec48))

## [2.1.1](https://github.com/chrischall/opencode-copilot-plugin/compare/v2.1.0...v2.1.1) (2026-11-09)


### Bug Fixes

* **deps:** update msal-node, otpauth, ws and zod ([#90](https://github.com/chrischall/opencode-copilot-plugin/issues/90)) ([33e4101](https://github.com/chrischall/opencode-copilot-plugin/commit/33e4101fd1e91dc4e2056d283af14427b715df56))

## [2.1.0](https://github.com/chrischall/opencode-copilot-plugin/compare/v2.0.0...v2.1.0) (2026-11-09)


### Features

* **models:** add mailbox-grounded m365/work models ([#86](https://github.com/chrischall/opencode-copilot-plugin/issues/86)) ([d928953](https://github.com/chrischall/opencode-copilot-plugin/commit/d928953fc069dfd4fa5785bd95826780d448b03b))


### Bug Fixes

* **server:** grounded models carry no tools, matching read-only Q&A docs ([#89](https://github.com/chrischall/opencode-copilot-plugin/issues/89)) ([635a6d0](https://github.com/chrischall/opencode-copilot-plugin/commit/635a6d017e1d62c967f3422a50f6e85189179af3))

## [2.0.0](https://github.com/chrischall/opencode-copilot-plugin/compare/v0.4.0...v2.0.0) (2026-11-03)


### ⚠ BREAKING CHANGES

* opencode 1 is no longer supported. Stay on 0.4.x for opencode 1; 2.0.0 and later fail to load there with "must default export an object with server()".

### Features

* drop opencode 1 support ([#82](https://github.com/chrischall/opencode-copilot-plugin/issues/82)) ([0034a1f](https://github.com/chrischall/opencode-copilot-plugin/commit/0034a1f0edfad4a03eb2d3371f8eabb29c162e7e))

## [0.4.0](https://github.com/chrischall/opencode-copilot-plugin/compare/v0.3.5...v0.4.0) (2026-11-03)


### Features

* show pasted images to the model ([#79](https://github.com/chrischall/opencode-copilot-plugin/issues/79)) ([f3da220](https://github.com/chrischall/opencode-copilot-plugin/commit/f3da2204e3c61eea23599cc73ea6fba88d11eb5d))


### Bug Fixes

* **deps:** Bump @azure/msal-node from 7.0.1 to 7.1.0 in the production-dependencies group ([#74](https://github.com/chrischall/opencode-copilot-plugin/issues/74)) ([3c3a240](https://github.com/chrischall/opencode-copilot-plugin/commit/3c3a24027e6e9bd4905360a3e2982a3e4c388aa5))
* **deps:** Bump @azure/msal-node from 7.1.0 to 7.1.1 in the production-dependencies group ([#77](https://github.com/chrischall/opencode-copilot-plugin/issues/77)) ([532c9e4](https://github.com/chrischall/opencode-copilot-plugin/commit/532c9e4140b0779a99b40ea4bc95d4200bcc8303))

## [0.3.5](https://github.com/chrischall/opencode-copilot-plugin/compare/v0.3.4...v0.3.5) (2026-10-17)


### Bug Fixes

* **deps:** Bump zod from 4.6.5 to 4.6.7 in the production-dependencies group ([#69](https://github.com/chrischall/opencode-copilot-plugin/issues/69)) ([0769c64](https://github.com/chrischall/opencode-copilot-plugin/commit/0769c642e7acf4b466a7f850ee6798c0dbbadec8))

## [0.3.4](https://github.com/chrischall/opencode-copilot-plugin/compare/v0.3.3...v0.3.4) (2026-10-09)


### Bug Fixes

* **deps:** Bump @azure/msal-node from 7.0.0 to 7.0.1 in the production-dependencies group ([#66](https://github.com/chrischall/opencode-copilot-plugin/issues/66)) ([4f44030](https://github.com/chrischall/opencode-copilot-plugin/commit/4f440303992671741594b885010a58364199e5a4))
* resolve low-severity audit findings ([#62](https://github.com/chrischall/opencode-copilot-plugin/issues/62)) ([ae84cda](https://github.com/chrischall/opencode-copilot-plugin/commit/ae84cda008ed6953546caf70a8dc7a5d69ec6250))

## [0.3.3](https://github.com/chrischall/opencode-copilot-plugin/compare/v0.3.2...v0.3.3) (2026-10-02)


### Bug Fixes

* **deps:** Bump @azure/msal-node from 6.0.1 to 7.0.0 in the production-majors group ([#60](https://github.com/chrischall/opencode-copilot-plugin/issues/60)) ([c8ce54d](https://github.com/chrischall/opencode-copilot-plugin/commit/c8ce54d827491d07889c34bfc0d3548b28ea8d2a))
* **deps:** Bump ws from 8.21.3 to 8.22.0 in the production-dependencies group ([#59](https://github.com/chrischall/opencode-copilot-plugin/issues/59)) ([cfdffb7](https://github.com/chrischall/opencode-copilot-plugin/commit/cfdffb72553e57d2ed8c349f0171f41582788c44))

## [0.3.2](https://github.com/chrischall/opencode-copilot-plugin/compare/v0.3.1...v0.3.2) (2026-09-24)


### Bug Fixes

* **deps:** Bump @azure/msal-node from 6.0.0 to 6.0.1 in the production-dependencies group ([#54](https://github.com/chrischall/opencode-copilot-plugin/issues/54)) ([a4665e7](https://github.com/chrischall/opencode-copilot-plugin/commit/a4665e7ab7a124f537649ee4823e46a07e2d74c3))

## [0.3.1](https://github.com/chrischall/opencode-copilot-plugin/compare/v0.3.0...v0.3.1) (2026-09-23)


### Bug Fixes

* **proxy:** lock the loopback proxy to opencode and fix conversation, setup and permission bugs ([#48](https://github.com/chrischall/opencode-copilot-plugin/issues/48)) ([6bae8f6](https://github.com/chrischall/opencode-copilot-plugin/commit/6bae8f67b11fa2f88c42cd5fb52e7117879c4690))
* stop chmodding $HOME, set the debug log up once, and retire allowedOrigins ([#51](https://github.com/chrischall/opencode-copilot-plugin/issues/51)) ([b1d0002](https://github.com/chrischall/opencode-copilot-plugin/commit/b1d000286ae87075635ec7b27a4d267ddea09d2c))

## [0.3.0](https://github.com/chrischall/opencode-copilot-plugin/compare/v0.2.2...v0.3.0) (2026-09-21)


### Features

* run on the opencode 2 plugin API without dropping opencode 1 ([#44](https://github.com/chrischall/opencode-copilot-plugin/issues/44)) ([a1e563f](https://github.com/chrischall/opencode-copilot-plugin/commit/a1e563f549e1e6d6ffbe75820d751d1eb8f42a83))


### Bug Fixes

* keep user plugin options when setup re-runs, and tighten the v2 schema guard ([#47](https://github.com/chrischall/opencode-copilot-plugin/issues/47)) ([741d03c](https://github.com/chrischall/opencode-copilot-plugin/commit/741d03cae7905c9c93a029d3d4412021e3598921))

## [0.2.2](https://github.com/chrischall/opencode-copilot-plugin/compare/v0.2.1...v0.2.2) (2026-09-03)


### Bug Fixes

* **plugin:** stop shadowing opencode's ./server plugin entry ([#29](https://github.com/chrischall/opencode-copilot-plugin/issues/29)) ([615a086](https://github.com/chrischall/opencode-copilot-plugin/commit/615a0860a70b7df927b2f415c894f0b042e356b9))


### Documentation

* **plugin:** credit Tess Hoffman for the default-export change ([#31](https://github.com/chrischall/opencode-copilot-plugin/issues/31)) ([da9f33c](https://github.com/chrischall/opencode-copilot-plugin/commit/da9f33c41b22843c7a492e28d13aa098b5b89711))

## [0.2.1](https://github.com/chrischall/opencode-copilot-plugin/compare/v0.2.0...v0.2.1) (2026-08-14)


### Bug Fixes

* **build:** ship the plugin with no runtime dependencies ([#18](https://github.com/chrischall/opencode-copilot-plugin/issues/18)) ([073cabe](https://github.com/chrischall/opencode-copilot-plugin/commit/073cabe3fadb19cca678583fb7f3f9380fec33b0))

## [0.2.0](https://github.com/chrischall/opencode-copilot-plugin/compare/v0.1.0...v0.2.0) (2026-08-14)


### Features

* use Microsoft 365 Copilot as opencode's model backend ([e30a38c](https://github.com/chrischall/opencode-copilot-plugin/commit/e30a38ce79b8db7ada5b486573c4b0ed9cb8f112))


### Bug Fixes

* **prompt:** preserve project rules in lean mode, and harden the tool trim ([#9](https://github.com/chrischall/opencode-copilot-plugin/issues/9)) ([a95c53d](https://github.com/chrischall/opencode-copilot-plugin/commit/a95c53d72c02c366600b83ebe4e21f3d47178c49))
* **types:** declare @opencode-ai/plugin as an optional peer dependency ([#7](https://github.com/chrischall/opencode-copilot-plugin/issues/7)) ([8cbb24b](https://github.com/chrischall/opencode-copilot-plugin/commit/8cbb24b9e0d95299eebb6d008de4ea13643b0859))
