# Xtrackers

One of the app's features lets you select Xtrackers ETFs in the Watchlist and aggregate their holdings to see how often each ticker appears across the selected funds. Repeated holdings make overlapping exposure visible: the more selected funds include a ticker, the greater its potential influence on the portfolio; gains in that holding may help, while declines may hurt, and actual impact also depends on each fund's position size.  Another feature makes it faster and easier to find funds with stronger growth over different periods, higher dividend yields or distributions, greater Total Return (price performance plus dividends), and other key performance metrics. A single-file client-side tool that reads the generated `./api/xtrackers` static feed (official etf.dws.com catalog/US sitemap, PDP facts and XLSX exports — expenses, yields, daily holdings, NAV history and distributions, with derived NAV returns — with SEC EDGAR N-PORT-P as a holdings fallback and Yahoo Finance daily prices/history/dividend fallbacks) into a searchable ETF/asset-class catalog with per-fund tabs, watchlist aggregation, ticker copy and CSV/TXT export — the same look, feel, columns and business logic as the sibling applications.

## Using Bun

```bash
bunx degit daggerok/Xtrackers#main ./12345 && cd $_
bunx serve . -p 1234
open http://0:1234
```

The deployment target is <https://daggerok.github.io/Xtrackers/>. Deployment is pending: this feature must first be merged to `main` by the owner and GitHub Pages enabled with GitHub Actions. The prepared Pages workflow never deploys an unmerged feature branch.

## Updating the static Xtrackers data

Run the updater with Bun:

```bash
bun test scripts/update-data.test.ts
./scripts/update-data.ts
```

Run `./scripts/update-data.ts -h` (or `--help`) to print every configuration variable with its default and usage examples.

The **Update Xtrackers ETF data** GitHub Actions workflow uses the same approach as [iShares](https://github.com/daggerok/iShares/blob/297a2e41e4a7a438ece2b8bde8e3384e960dfaeb/.github/workflows/update-data.yml): Sunday 00:00 UTC and manual runs; all 23 supported controls are optional string inputs with empty defaults, mapped to job-level ENV. Checkout v7 → setup-bun v2 (no fixed Bun version) → frozen install → updater tests → updater → commit/push only changed `api/xtrackers` files. No changes means no commit. A failed updater prevents the commit step; it still continues per fund and preserves previously published data. In GitHub Actions it automatically appends configuration, counts, filtered/failure reasons and retained-source diagnostics to `GITHUB_STEP_SUMMARY`.

[scripts/update-data.config.json](scripts/update-data.config.json) is the checked-in runtime default, loaded relative to the updater, not the current working directory. Edit this flat JSON to change defaults locally and in Actions. Any **nonblank ENV value wins over JSON**, including `0` and `false`; absent, empty or whitespace-only values inherit JSON. Thus blank manual inputs and scheduled runs use the same checked-in defaults. Only a missing JSON file permits built-in fallbacks; malformed or unreadable configuration fails instead of being silently ignored. `--help` prints the JSON defaults. DWS-safe pacing stays at **1.5 seconds / 2 lanes** rather than copying iShares' issuer-specific 0/4. `STORE_RAW_DOWNLOADS` and provider-skip switches are not supported. All supplied filters use **AND** logic.

CI and the main-only Pages workflow retain their checks/deployment guards and use the same checkout/setup-bun conventions. Dependabot remains monthly for Bun and GitHub Actions. Checkout never persists credentials; the push step uses the runner token only in process memory via a temporary nonsecret askpass program, never a token in a file or Git configuration.

### Data sources

| Block | Source |
| --- | --- |
| Catalog (all US Xtrackers ETFs) | Official DWS monthly/quarterly fund-finder XLSX: `/api/fundfinder/en-us/downloadxls/?tab=1&filters=...`; [US sitemap](https://etf.dws.com/en-us/sitemap.xml) when the workbook is empty/unavailable; previously published catalog retained if both fail. |
| Holdings per fund | `https://etf.dws.com/api/pdp/en-us/export/etf/{TICKER}/Securities` (official daily XLSX; e.g. [ASHR](https://etf.dws.com/api/pdp/en-us/export/etf/ASHR/Securities)); legal name, expenses, assets and yields from `/api/pdp/en-us/etfus/{TICKER}/pdpMetaTagsTealium`. |
| Daily history, distributions | `/api/pdp/en-us/Export/etf/{TICKER}/Performance` (daily NAV, capital E) and `/api/pdp/en-us/export/etf/{TICKER}/Distributions` (total cash distributions, XLSX). |
| Fallback | SEC EDGAR N-PORT-P holdings only (DBX ETF TRUST, CIK `0001503123`, exact series/trust matching) + Yahoo Finance chart prices/dividends/history; previously published data as the last resort. |

The official finder workbook was genuinely empty during research; the official US sitemap provided dynamic discovery, not a hardcoded ticker list. The initial published snapshot contains **42 discovered funds, 3 downloaded (ASHR, HYLB, DBEF), 39 catalog-only**: 2,238 positions and 9,562 daily-history rows. Later live discovery found 43 funds; a scoped run does not insert or modify an unrequested new entry. A full pass populates new discoveries. The later external data-only update on this feature branch contains **43 funds, 21,171 positions and 77,473 history rows**; this configuration/workflow follow-up leaves those published files unchanged. Unknown facts are unavailable, never invented as zero.

Official NAV history uses `Date / NAV / Market Price / Premium/Discount`; the market price comes from Yahoo and premium/discount requires a matching NAV date. Yahoo-only fallback uses `Date / Close / Adj Close / Volume`, with adjusted closes rounded to two decimals. Dataset source dates can differ and returns use the covered NAV series, not the fetch timestamp or a newer headline date. NAV total returns reinvest the total cash distribution once on the exact ex-date. Missing payout NAV, stale window anchors, incomplete inception coverage and young funds leave unsupported metrics unavailable; Morningstar ratings are not performance returns. Derived figures are **not published standardized NAV returns**.

SEC endpoints returned HTTP 403 in this environment; SEC fallback is implemented and exercised offline, but fresh SEC success is not claimed. Official DWS holdings satisfied the real three-fund acceptance. Logs, provenance, scope checks and repeat hashes are in [final live evidence](research/2026-10-01/scoped-live-smoke-v3/summary.json). The first observed Yahoo half-cent adjustment variance is retained separately, not hidden.

Each fund carries a derived `metrics` object that powers the catalog columns shared with the sibling sites:

- `ytd` / `tr1y` — official or coverage-checked derived NAV YTD and 1-year returns → *YTD Return*, *TR 1Y*
- `cagr3y` / `cagr5y` / `cagr10y` — published or coverage-checked derived annualized 3Y/5Y/10Y figures → *CAGR 3Y/5Y/10Y*
- `tr3y` / `tr5y` / `tr10y` — cumulative 3Y/5Y/10Y figures `(1 + CAGR)^n - 1` → *TR 3Y/5Y/10Y*
- `siAnn` — since-inception annualized when date/age/coverage support it (not young cumulative SI) → *SI Ann.*
- `dividendYield` — official indicated distribution rate, or latest positive distribution × frequency ÷ NAV
- `secYield` — 30-day SEC yield when published; `—` otherwise

### Update controls

Defaults below are from `scripts/update-data.config.json`; blank Actions inputs do not override them.

| Environment variable | Default | Meaning |
| --- | --: | --- |
| `MAX_FETCHES` | `0` | Batch evaluation size: positive resumes the scoped cursor in `api/xtrackers/update-state.json`; `0` is a full selected pass. A failed fund prevents cursor advancement. |
| `REQUEST_SLEEP` | `1.5` | Minimum seconds between outgoing request starts **in each independent lane**, including retries; normal DWS pacing is 1.5 seconds. |
| `CONCURRENCY` | `2` | Parallel fund workers / independent paced lanes; two lanes, not one global bottleneck. |
| `TICKERS` | all | Space/comma/semicolon allowlist, e.g. ASHR HYLB DBEF. Unknown requested tickers fail before writes. |
| `AUM` | `:` | Net Assets range: USD amounts or K/M/B/T suffixes; nano/micro/small/mid/large presets; inclusive min:max. |
| `TER` | `:` | Gross expense ratio range in % (strict min:max). |
| `DIVIDEND_YIELD` | `:` | Distribution-yield range in %, min:max; missing values do not pass an active range. |
| `SEC_YIELD` | `:` | Official 30-day SEC-yield range in %, min:max; missing values do not pass. |
| `HOLDINGS_PAGE_SIZE` | `250` | Current holdings rows per JSON page |
| `HISTORY_PAGE_SIZE` | `1000` | Daily history rows per JSON page |
| `MAX_RETRIES` | `2` | Retries after the initial request (transient HTTP/network failures only) |
| `SEC_UA` | declared UA | SEC contact User-Agent; override with your real contact. Do not put credentials here. |
| `VERBOSE` | `false` | Provider/fallback/retry detail; the normal compact fund reporter always retains real zero/false and omits missing fields. |
| `PERFORMANCE_YTD` | `:` | YTD performance percent min:max (3Y/5Y/10Y annualized) |
| `TOTAL_RETURN_YTD` | `:` | YTD cumulative total return percent min:max |
| `PERFORMANCE_1Y` | `:` | 1Y performance percent min:max (3Y/5Y/10Y annualized) |
| `TOTAL_RETURN_1Y` | `:` | 1Y cumulative total return percent min:max |
| `PERFORMANCE_3Y` | `:` | 3Y performance percent min:max (3Y/5Y/10Y annualized) |
| `TOTAL_RETURN_3Y` | `:` | 3Y cumulative total return percent min:max |
| `PERFORMANCE_5Y` | `:` | 5Y performance percent min:max (3Y/5Y/10Y annualized) |
| `TOTAL_RETURN_5Y` | `:` | 5Y cumulative total return percent min:max |
| `PERFORMANCE_10Y` | `:` | 10Y performance percent min:max (3Y/5Y/10Y annualized) |
| `TOTAL_RETURN_10Y` | `:` | 10Y cumulative total return percent min:max |

`TICKERS` combines with AUM, TER, yield and return filters using AND logic; it does not override them. Funds not selected for a successful update keep their prior published metadata and data files.

### Examples

```bash
MAX_FETCHES=10 ./scripts/update-data.ts
TICKERS="ASHR HYLB DBEF" ./scripts/update-data.ts
AUM="1B:" TER=":0.5" ./scripts/update-data.ts
PERFORMANCE_1Y="15:" ./scripts/update-data.ts
```

## TypeScript

The browser app is intentionally build-free: `index.html` carries the markup, styles and bootstrap, and `app.tsx` is TypeScript compiled in the browser with Babel standalone — no build step, no bundler, no `tsconfig.json` needed. Bun runs TypeScript out of the box.

Verification before every publish: `bun install --frozen-lockfile`, `bun test`, and `git diff --check`.

## Brands table

| Brand | Where to get the data |
| --- | --- |
| **abrdn (Aberdeen)** | [aberdeeninvestments.com](https://www.aberdeeninvestments.com/en-us/investor/funds/etfs) \| [aberdeen](https://daggerok.github.io/aberdeen/) |
| **Amplify** | [amplifyetfs.com](https://amplifyetfs.com/) \| [Amplify](https://daggerok.github.io/Amplify/) |
| **Capital Group** | [capitalgroup.com](https://www.capitalgroup.com/advisor/investments/exchange-traded-funds.html) \| [Capital-Group](https://daggerok.github.io/Capital-Group/) |
| **Fidelity** | [fidelity.com](https://www.fidelity.com/etfs) \| [Fidelity](https://daggerok.github.io/Fidelity/) |
| **First Trust** | [ftportfolios.com](https://www.ftportfolios.com/Retail/etf/etflist.aspx) \| [First-Trust](https://daggerok.github.io/First-Trust/) |
| **Franklin Templeton** | [franklintempleton.com](https://www.franklintempleton.com/investments/options/exchange-traded-funds) \| [Franklin](https://daggerok.github.io/Franklin/) |
| **Global X** | [globalxetfs.com/explore](https://www.globalxetfs.com/explore) \| [Global X](https://daggerok.github.io/Global-X/) |
| **Goldman Sachs** | [am.gs.com](https://am.gs.com/en-us/individual/funds?locale=en-us&audience=individual&sf=funds&filters=funds%7CETF&limit=100) \| [Goldman-Sachs](https://daggerok.github.io/Goldman-Sachs/) |
| **Invesco** | [invesco.com](https://www.invesco.com/us/en/financial-products/etfs.html) \| [Invesco](https://daggerok.github.io/Invesco/) |
| **iShares** | [ishares.com](https://www.ishares.com/) \| [iShares](https://daggerok.github.io/iShares/) |
| **JPMorgan** | [am.jpmorgan.com](https://am.jpmorgan.com/us/en/asset-management/adv/products/fund-explorer/etf) \| [JPMorgan](https://daggerok.github.io/JPMorgan/) |
| **NEOS** | [neosfunds.com](https://neosfunds.com/#explore-etfs) \| [Neos](https://daggerok.github.io/Neos/) |
| **Northern Trust** | [etfs.ntam.northerntrust.com](https://etfs.ntam.northerntrust.com/us/en/individual/funds) \| [Northern-Trust](https://daggerok.github.io/Northern-Trust/) |
| **ProShares** | [proshares.com](https://www.proshares.com/our-etfs/find-proshares-etfs) \| [ProShares](https://daggerok.github.io/ProShares/) |
| **Schwab** | [schwabassetmanagement.com](https://www.schwabassetmanagement.com/products) \| [Schwab](https://daggerok.github.io/Schwab/) |
| **SPDR** | [ssga.com](https://www.ssga.com/us/en/intermediary/etfs/fund-finder) \| [SPDR](https://daggerok.github.io/SPDR/) |
| **VanEck** | [vaneck.com](https://www.vaneck.com/us/en/etf-mutual-fund-finder/) \| [VanEck](https://daggerok.github.io/VanEck/) |
| **Vanguard** | [investor.vanguard.com](https://investor.vanguard.com/etf/list) \| [Vanguard](https://daggerok.github.io/Vanguard/) |
| **VictoryShares** | [vcm.com VictoryShares ETFs](https://www.vcm.com/products/victoryshares-etfs/victoryshares-etfs-list) \| [VictoryShares](https://daggerok.github.io/VictoryShares/) |
| **WisdomTree** | [wisdomtree.com](https://www.wisdomtree.com/investments) \| [WisdomTree](https://daggerok.github.io/WisdomTree/) |
| **Xtrackers** | [etf.dws.com](https://etf.dws.com/en-us/etf-products/) \| [Xtrackers](https://daggerok.github.io/Xtrackers/) |

## Sibling applications

| Application | Data provider | Repository |
| --- | --- | --- |
| abrdn (Aberdeen) | Official Aberdeen gateway + SEC N-PORT holdings fallback + Yahoo history/dividends | [aberdeen](https://github.com/daggerok/aberdeen) |
| Amplify | Amplify ETFs (Firestore data feed) | [Amplify](https://github.com/daggerok/Amplify) |
| Capital Group | Official Capital Group fund data + SEC N-PORT holdings fallback + Yahoo history fallback | [Capital-Group](https://github.com/daggerok/Capital-Group) |
| Fidelity | SEC EDGAR N-PORT-P + Yahoo Finance | [Fidelity](https://github.com/daggerok/Fidelity) |
| First Trust | ftportfolios.com official ETF list + fund summary, holdings, distribution and price-history export pages + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history fallback | [First-Trust](https://github.com/daggerok/First-Trust) |
| Franklin Templeton | franklintempleton.com ETF listings + product pages + SEC EDGAR N-PORT-P | [Franklin](https://github.com/daggerok/Franklin) |
| Global X | globalxetfs.com Next.js catalog and fund pages + dated full-holdings CSV | [Global X](https://github.com/daggerok/Global-X) |
| Goldman Sachs | am.gs.com fund finder + detail pages + SEC EDGAR N-PORT-P | [Goldman-Sachs](https://github.com/daggerok/Goldman-Sachs) |
| Invesco | invesco.com CSV downloads + Yahoo Finance | [Invesco](https://github.com/daggerok/Invesco) |
| iShares | iShares (BlackRock) product workbooks | [iShares](https://github.com/daggerok/iShares) |
| JPMorgan | am.jpmorgan.com fund explorer + product-data JSON | [JPMorgan](https://github.com/daggerok/JPMorgan) |
| NEOS | neosfunds.com lineup table + official fund pages + daily holdings CSV | [Neos](https://github.com/daggerok/Neos) |
| Northern Trust | etfs.ntam.northerntrust.com funds list + per-fund CSV/JSON downloads | [Northern-Trust](https://github.com/daggerok/Northern-Trust) |
| ProShares | proshares.com ETF finder + fund pages + official data host | [ProShares](https://github.com/daggerok/ProShares) |
| Schwab | schwabassetmanagement.com product pages + CSV exports | [Schwab](https://github.com/daggerok/Schwab) |
| SPDR | SSGA / State Street public feeds | [SPDR](https://github.com/daggerok/SPDR) |
| VanEck | vaneck.com ETF finder + product pages | [VanEck](https://github.com/daggerok/VanEck) |
| Vanguard | Vanguard product pages + SEC EDGAR N-PORT-P | [Vanguard](https://github.com/daggerok/Vanguard) |
| VictoryShares | VCM VictoryShares catalog and product JSON + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance adjusted-market-price history | [VictoryShares](https://github.com/daggerok/VictoryShares) |
| WisdomTree | WisdomTree product table + SEC EDGAR N-PORT-P + Yahoo Finance | [WisdomTree](https://github.com/daggerok/WisdomTree) |
| Xtrackers | Official DWS catalog/US sitemap + PDP/XLSX + SEC N-PORT-P holdings fallback + Yahoo Finance daily prices/history/dividends | [Xtrackers](https://github.com/daggerok/Xtrackers) |

## License

[MIT — same as all sibling ETF repositories.](./LICENSE)

Xtrackers® and DWS® and the fund names/tickers referenced here are trademarks of DWS Group This is an independent, unofficial tool; it is not affiliated with, endorsed by, or sponsored by DWS or Xtrackers All data is reproduced from DWS's own public fund pages and downloads, public SEC EDGAR filings and Yahoo Finance for research purposes. All other trademarks, including index names, are the property of their respective owners.
