# Xtrackers

One of the app's features lets you select Xtrackers ETFs in the Watchlist and aggregate their holdings to see how often each ticker appears across the selected funds. Repeated holdings make overlapping exposure visible: the more selected funds include a ticker, the greater its potential influence on the portfolio; gains in that holding may help, while declines may hurt, and actual impact also depends on each fund's position size.  Another feature makes it faster and easier to find funds with stronger growth over different periods, higher dividend yields or distributions, greater Total Return (price performance plus dividends), and other key performance metrics. A single-file client-side tool that reads the generated `./api/xtrackers` static feed (official etf.dws.com catalog/US sitemap, PDP facts and XLSX exports - expenses, yields, daily holdings, NAV history and distributions, with derived NAV returns - with SEC EDGAR N-PORT-P as a holdings fallback and Yahoo Finance daily prices/history/dividend fallbacks) into a searchable ETF/asset-class catalog with per-fund tabs, watchlist aggregation, ticker copy and CSV/TXT export - the same look, feel, columns and business logic as the sibling applications.

## Using Bun

```bash
bunx degit daggerok/Xtrackers#main ./12345 && cd $_
bun install
bun run serve
```

`bun run serve` starts the Parcel dev server (it copies `api/` to `dist/api` first) and prints the local address. `bun run build` writes the site to `dist/`, `bun run build-github-pages` does the same with the `/Xtrackers/` public URL used by the Pages workflow.

The application is published at <https://daggerok.github.io/Xtrackers/>. The site is deployed by `.github/workflows/github-pages.yml` (GitHub Actions) from `main`.

### Column types and filters

Every column of the ETF catalog and of the Watchlist, Holdings, History and Distributions tabs has a type: text (`ABC`), number (`123`), percentage (`%`), money (`$`), date (`D`), date and time (`DT`) or time of day (`T`). The type is detected from the texts the column shows (80% of the filled cells must agree, otherwise text) and is written in the badge next to the column title: click it to cycle the type, Shift+click to return to auto-detection. Dates are read as `2024-06-15`, `6/15/2024`, `15.06.2024`, `Jun 15, 2024` or `15-Jun-2024`, date and time as `2024-06-15T09:30:00Z` or `2024-06-15 09:30`, time as `09:30`, `16:00:00` or `9:30 PM`

A row of filter inputs sits under the column headers (the `Filters` button hides it, `Clear filters` empties it). Filters of different columns are combined with AND, the search box applies on top, and Copy Tickers and the exports use the filtered rows. Filters and type overrides are remembered in the browser. `Sticky #` (next to `Filters`, off by default, remembered in the browser) numbers the rows by their rank in the table sorted by the current column before the column filters, so a filtered fund keeps its rank and the numbers keep gaps; the sort, the search and the category and blacklist choices rank again. The catalog starts sorted by Net Assets, largest first, unavailable values sort last in both directions, and every export starts with the `#` column. The red `Clear` button opens a dialog that lists what can be reset (the selection, searches, sort order, open tab, shown columns, column filters, remembered table views and the blacklist), all ticked the first time and afterwards as they were left at the last OK; `Enter` confirms, `Esc` or a click outside cancels, the theme is always kept, so the page looks like a first visit (also after a reload)

Inside one filter: a space means AND, a comma means OR, a leading `!` means NOT, `?` matches an empty or unavailable value and `!?` a value that is there; a value that is unavailable matches only `?` and negated conditions. An unquoted space ends the value, so quote values that contain one (`>="2024-06-15 09:30"`)

| Type | Examples |
| --- | --- |
| Text | `bank` contains, `"two words"`, `!bank`, `=exact`, `^starts`, `ends$`, `/regex/`, `tech, health` |
| Number, percentage, money | `>10`, `>=10 <50`, `=22` (matches what rounds to 22), `!=22`, `10..50`, `..50`, `10..`, `>1B` and `K` `M` `B` `T` suffixes, an optional `$` or `%` |
| Date, date and time | `>2024-06-01`, `2024` (the whole year), `2024-06` (the whole month), `2024-01..2024-06`, `today`, `yesterday`, `-7d..` (the last 7 days), `+2w`, `-3m`, `-1y` |
| Time | `>09:30`, `09:30..16:00`, `=12:00` (the whole minute) |

The `Columns` menu next to `Filters` lists every column of the ETF table from the first to the last, all of them shown by default, with a search box and the `All`, `Clear`, `Toggle` and `Reset` buttons. `Use` and `Ticker` are listed but locked. Hiding a column only removes it from the table: the filters, the sorting, the exports and Copy Tickers still use it. The choice is remembered in the browser (localStorage, never the data) and the menu is shown on the ETF catalog only

The asset classes are one `Asset classes` multi-select next to the `All ETFs` pill instead of one tab per class: every class is selected by default (= all ETFs), `Only` or unchecking narrows the table, and the `All ETFs` pill is lit only while nothing narrows it (all or none of the classes checked); clicking the pill clears the selection. The choice is remembered in the browser (localStorage, never the data)

## Updating the static Xtrackers data

Run the updater with Bun:

```bash
bun test
bun scripts/update-data.ts
```

Run `bun scripts/update-data.ts --help` to print every control with its default and usage examples.

[scripts/update-data.config.json](scripts/update-data.config.json) is the checked-in runtime default for every supported control, loaded relative to the updater, not the current working directory. Edit this flat JSON to change defaults locally and in Actions. Precedence: file defaults < `advanced` JSON < nonblank workflow inputs < environment variable < protected Actions variable (`SEC_UA`, workflow only). An environment variable that is explicitly set wins over every file and input layer, including `0`, `false` and an empty value (empty clears the control to its built-in default); an unset variable inherits the layer below. The workflow writes the resolved values to `GITHUB_ENV` and the updater resolves them again, so the environment is authoritative. Blank manual inputs and scheduled runs use the checked-in defaults. Unknown keys, non-scalar values and CR/LF/NUL are rejected, every control is validated strictly (integers, booleans, ranges, `min:max` filters; an invalid value is an error, never a silent fallback), and a missing JSON file is the only case that falls back to built-in defaults. The CLI and the workflow share one resolver (`resolveControls` in `scripts/update-data.ts`). DWS-safe pacing stays at **1.5 seconds / 2 lanes**. All supplied filters use **AND** logic.

The **Update Xtrackers ETF data** GitHub Actions workflow runs on Sunday 00:00 UTC and manually. It exposes the 24 most used controls as individual optional inputs plus an `advanced` JSON object for any control by its UPPER_CASE name (`TOTAL_RETURN_5Y` and `TOTAL_RETURN_10Y` are reachable only through `advanced`). Steps: checkout without persisted credentials, setup-bun, frozen install, tests, resolve controls, updater, commit and push only changed `api/xtrackers` files with a runtime-only token. No changes means no commit. A failed updater still lets the commit step run for the funds it did publish, and previously published data is preserved. The output directory is fixed and cannot be set from the workflow. The repository Actions variable `SEC_UA` overrides every other layer when nonblank and is never printed. In GitHub Actions the updater appends configuration (with `SEC_UA` redacted), counts, filtered/failure reasons and retained-source diagnostics to `GITHUB_STEP_SUMMARY`.

CI and the main-only Pages workflow keep their checks and deployment guards. Dependabot is monthly for Bun and GitHub Actions.

### Data sources

| Block | Source |
| --- | --- |
| Catalog (all US Xtrackers ETFs) | Official DWS monthly/quarterly fund-finder XLSX: `/api/fundfinder/en-us/downloadxls/?tab=1&filters=...`; [US sitemap](https://etf.dws.com/en-us/sitemap.xml) when the workbook is empty/unavailable; previously published catalog retained if both fail. |
| Holdings per fund | `https://etf.dws.com/api/pdp/en-us/export/etf/{TICKER}/Securities` (official daily XLSX; e.g. [ASHR](https://etf.dws.com/api/pdp/en-us/export/etf/ASHR/Securities)); legal name, expenses, assets and yields from `/api/pdp/en-us/etfus/{TICKER}/pdpMetaTagsTealium`. |
| Daily history, distributions | `/api/pdp/en-us/Export/etf/{TICKER}/Performance` (daily NAV, capital E) and `/api/pdp/en-us/export/etf/{TICKER}/Distributions` (total cash distributions, XLSX). |
| Fallback | SEC EDGAR N-PORT-P holdings only (DBX ETF TRUST, CIK `0001503123`, exact series/trust matching) + Yahoo Finance chart prices/dividends/history; previously published data as the last resort. |

### Metrics and caveats

The official finder workbook came back empty in live checks, so catalog discovery falls back to the official US sitemap (dynamic, not a hardcoded ticker list); the published `index.json` records which source was used. A scoped run does not insert or modify an unrequested new entry, and a full pass populates new discoveries. Funds that were never updated stay catalog-only (no holdings or history files). Unknown facts are unavailable, never invented as zero.

Official NAV history uses `Date / NAV / Market Price / Premium/Discount`; the market price comes from Yahoo and premium/discount is computed from the latest date that has both an official NAV and a Yahoo close (within 7 days of the newest point), published with `premiumDiscountAsOfDate`; with no such pair it is empty (`null`), never a mixed-date number. Yahoo-only fallback uses `Date / Close / Adj Close / Volume`, with adjusted closes rounded to two decimals. Dataset source dates can differ and returns use the covered NAV series, not the fetch timestamp or a newer headline date. NAV total returns reinvest the total cash distribution once on the exact ex-date. Missing payout NAV, stale window anchors, incomplete inception coverage and young funds leave unsupported metrics unavailable; Morningstar ratings are not performance returns. Derived figures are **not published standardized NAV returns**.

The SEC N-PORT-P fallback runs only when official DWS holdings fail and `EDGAR_FALLBACK` is enabled; it requires the exact trust and series and sends the `SEC_UA` contact User-Agent (SEC rejects a User-Agent without a contact with HTTP 403). Yahoo adjusted-close half-cent variance never changes the official NAV history.

Each fund carries a derived `metrics` object that powers the catalog columns shared with the sibling sites:

- `ytd` / `tr1y` - official or coverage-checked derived NAV YTD and 1-year returns -> *YTD Return*, *TR 1Y*
- `cagr3y` / `cagr5y` / `cagr10y` - published or coverage-checked derived annualized 3Y/5Y/10Y figures -> *CAGR 3Y/5Y/10Y*
- `tr3y` / `tr5y` / `tr10y` - cumulative 3Y/5Y/10Y figures `(1 + CAGR)^n - 1` -> *TR 3Y/5Y/10Y*
- `siAnn` - since-inception annualized when date/age/coverage support it (not young cumulative SI) -> *SI Ann.*
- `dividendYield` - official indicated distribution rate, or latest positive distribution × frequency ÷ NAV when the rate is missing; when the official rate is 0 but distributions were paid in the last 12 months, the trailing 12-month distributions ÷ NAV; a published 0.00% with no payments in 12 months stays 0 and `yields.dividendYieldKind` says so
- `dividendYieldBasis` - code of the definition behind `dividendYield`, `null` exactly when the yield is `null`:

  | Code | Meaning for Xtrackers |
  | --- | --- |
  | `official-distribution-rate` | the official DWS distribution rate (also a published 0.00% with no payments in 12 months) |
  | `computed-trailing-12m` | the official rate is 0 but distributions were paid: trailing 12-month distributions ÷ NAV |
  | `indicated` | no official rate: latest positive distribution × payments per year ÷ NAV |
- `terValue` / `terGrossValue` - net expense ratio (after waivers; the gross one when it is the only number) and gross expense ratio (`Total operating expenses`), with `ter` / `terGross` text; `meta.json` keeps `netTerValue`
- `secYield` - 30-day SEC yield when published; `—` otherwise
- `returnsBasis` - mandatory non-empty label of how the returns were computed: official DWS NAV total returns, derived from the official DWS daily NAV with distributions reinvested at ex-date NAV, or derived from Yahoo adjusted market-price closes (an estimate, not official NAV returns)
- `quarterEnd` - derived for the last completed quarter-end on or before the newest NAV date: it equals `monthEnd` only when the data ends exactly on a quarter-end (for example 09-30)
- `performanceAsOf` - mandatory ISO `YYYY-MM-DD` date the returns are as of: the DWS performance table date for official figures, the last covered series date when derived (never the NAV date); `null` when no return figure exists (or the date is unknown)

### Update controls

Defaults below are from `scripts/update-data.config.json`; blank Actions inputs do not override them. Every control can be set through `advanced`; all except `TOTAL_RETURN_5Y` and `TOTAL_RETURN_10Y` are also individual workflow inputs (lowercase name). Every control also reads `XTRACKERS_<NAME>` from the environment (for example `XTRACKERS_CONCURRENCY=7`), and `HISTORICAL_PAGE_SIZE` is an alias of `HISTORY_PAGE_SIZE`. Aliases sit in the environment layer: the plain name wins when both are set, an explicitly empty alias counts as set, and validation is the same.

| Environment variable | Default | Meaning |
| --- | --: | --- |
| `MAX_FETCHES` | `0` | Batch evaluation size: positive resumes the scoped cursor in `api/xtrackers/update-state.json`; `0` is a full selected pass. The cursor moves past every fund taken (failed or filtered too) and is kept per filter scope (`TICKERS` included): a run with other filters never moves or deletes it; only an unfiltered full pass resets its own scope. |
| `REQUEST_SLEEP` | `1.5` | Minimum seconds between outgoing request starts **in each independent lane**, including retries; normal DWS pacing is 1.5 seconds. |
| `CONCURRENCY` | `2` | Parallel fund workers / independent paced lanes; two lanes, not one global bottleneck. |
| `TICKERS` | all | Space/comma/semicolon allowlist, e.g. ASHR HYLB DBEF. Unknown requested tickers fail before writes. |
| `AUM` | `:` | Net Assets range: USD amounts or K/M/B/T suffixes; nano/micro/small/mid/large presets; inclusive min:max. |
| `TER` | `:` | Net expense ratio range in % (the gross ratio when no net one is published; strict min:max). |
| `DIVIDEND_YIELD` | `:` | Distribution-yield range in %, min:max; missing values do not pass an active range. |
| `SEC_YIELD` | `:` | Official 30-day SEC-yield range in %, min:max; missing values do not pass. |
| `HOLDINGS_PAGE_SIZE` | `250` | Current holdings rows per JSON page |
| `HISTORY_PAGE_SIZE` | `1000` | Daily history rows per JSON page |
| `MAX_RETRIES` | `2` | Retries after the initial request, integer >= 1 (transient HTTP/network failures only) |
| `HISTORY_RANGE` | `max` | Yahoo request window and published history rows: `max` or `Ny` (e.g. `5y`); returns still use the full NAV series |
| `SEC_UA` | `daggerok ETF feed daggerok@gmail.com` | User-Agent with a real contact for SEC EDGAR; the repository Actions variable `SEC_UA` overrides it. Redacted in logs. Do not put credentials here. |
| `SKIP_YAHOO` | `false` | Do not call Yahoo Finance; published prices are retained |
| `EDGAR_FALLBACK` | `true` | Use the SEC N-PORT-P holdings fallback when official holdings fail |
| `VERBOSE` | `false` | Provider/fallback/retry detail; the normal compact fund reporter always retains real zero/false and omits missing fields. |
| `USE_SYSTEM_CA` | `auto` | TLS trust store: `auto` restarts the updater once with Bun's `--use-system-ca` when a request fails with an untrusted-certificate error; `true` always uses the system CA store; `false` never restarts. Not an individual workflow input: use `advanced`, the config file or the CLI environment. |
| `PERFORMANCE_YTD` | `:` | YTD performance percent min:max (3Y/5Y/10Y annualized) |
| `PERFORMANCE_1Y` | `:` | 1Y performance percent min:max (3Y/5Y/10Y annualized) |
| `PERFORMANCE_3Y` | `:` | 3Y performance percent min:max (3Y/5Y/10Y annualized) |
| `PERFORMANCE_5Y` | `:` | 5Y performance percent min:max (3Y/5Y/10Y annualized) |
| `PERFORMANCE_10Y` | `:` | 10Y performance percent min:max (3Y/5Y/10Y annualized) |
| `TOTAL_RETURN_YTD` | `:` | YTD cumulative total return percent min:max |
| `TOTAL_RETURN_1Y` | `:` | 1Y cumulative total return percent min:max |
| `TOTAL_RETURN_3Y` | `:` | 3Y cumulative total return percent min:max |
| `TOTAL_RETURN_5Y` | `:` | 5Y cumulative total return percent min:max |
| `TOTAL_RETURN_10Y` | `:` | 10Y cumulative total return percent min:max |

`TICKERS` combines with AUM, TER, yield and return filters using AND logic; it does not override them. Funds not selected for a successful update keep their prior published metadata and data files. The run takes no new fund after 25 minutes and still writes the index. When the live catalog adds funds the run prints `NEW FUNDS: ...` and lists them in the Actions step summary. A row without `funds/<T>/meta.json` has `dataFile: null`; others use `./funds/<T>/meta.json`. An SEC filing older than the published holdings never replaces them.

### Examples

```bash
MAX_FETCHES=10 bun scripts/update-data.ts
TICKERS="ASHR HYLB DBEF" bun scripts/update-data.ts
AUM="1B:" TER=":0.5" bun scripts/update-data.ts
PERFORMANCE_1Y="15:" bun scripts/update-data.ts
HISTORY_RANGE=5y TICKERS=ASHR bun scripts/update-data.ts
```

Workflow `advanced` input example: `{"MAX_RETRIES": 3, "TOTAL_RETURN_5Y": "5:"}`

## TypeScript and verification

The browser app lives in `src/`: `src/index.html` carries the markup, `src/main.tsx` is the TypeScript app, `src/index.css` holds Tailwind v4 and the component styles. Parcel bundles them into `dist/` (`bun run build`) - no `tsconfig.json` needed, Bun runs the updater TypeScript out of the box.

Verification before every publish:

```bash
bun install --frozen-lockfile
bun test
bun build --target=bun scripts/update-data.ts --outfile=/dev/null
git diff --check
```

`bun test` runs the offline suite in `scripts/update-data.test.ts`: it checks the config file, `--help` and the README controls table against `CONTROL_NAMES`, the workflow shape, the README structure and the parsers.

## Brands table

| Brand | Where to get the data |
| --- | --- |
| **AAM** | [aamlive.com](https://www.aamlive.com/ETF) \| [AAM](https://daggerok.github.io/AAM/) |
| **abrdn (Aberdeen)** | [aberdeeninvestments.com](https://www.aberdeeninvestments.com/en-us/investor/funds/etfs) \| [aberdeen](https://daggerok.github.io/aberdeen/) |
| **Amplify** | [amplifyetfs.com](https://amplifyetfs.com/) \| [Amplify](https://daggerok.github.io/Amplify/) |
| **ARK Invest** | [ark-funds.com](https://www.ark-funds.com/our-etfs/) \| [ARK](https://daggerok.github.io/ARK/) |
| **Capital Group** | [capitalgroup.com](https://www.capitalgroup.com/advisor/investments/exchange-traded-funds.html) \| [Capital-Group](https://daggerok.github.io/Capital-Group/) |
| **Fidelity** | [fidelity.com](https://www.fidelity.com/etfs) \| [Fidelity](https://daggerok.github.io/Fidelity/) |
| **First Trust** | [ftportfolios.com](https://www.ftportfolios.com/Retail/etf/etflist.aspx) \| [First-Trust](https://daggerok.github.io/First-Trust/) |
| **Franklin Templeton** | [franklintempleton.com](https://www.franklintempleton.com/investments/options/exchange-traded-funds) \| [Franklin](https://daggerok.github.io/Franklin/) |
| **Global X** | [globalxetfs.com/explore](https://www.globalxetfs.com/explore) \| [Global-X](https://daggerok.github.io/Global-X/) |
| **Goldman Sachs** | [am.gs.com](https://am.gs.com/en-us/individual/funds?locale=en-us&audience=individual&sf=funds&filters=funds%7CETF&limit=100) \| [Goldman-Sachs](https://daggerok.github.io/Goldman-Sachs/) |
| **Invesco** | [invesco.com](https://www.invesco.com/us/en/financial-products/etfs.html) \| [Invesco](https://daggerok.github.io/Invesco/) |
| **iShares** | [ishares.com](https://www.ishares.com/) \| [iShares](https://daggerok.github.io/iShares/) |
| **JPMorgan** | [am.jpmorgan.com](https://am.jpmorgan.com/us/en/asset-management/adv/products/fund-explorer/etf) \| [JPMorgan](https://daggerok.github.io/JPMorgan/) |
| **NEOS** | [neosfunds.com](https://neosfunds.com/#explore-etfs) \| [Neos](https://daggerok.github.io/Neos/) |
| **Northern Trust** | [etfs.ntam.northerntrust.com](https://etfs.ntam.northerntrust.com/us/en/individual/funds) \| [Northern-Trust](https://daggerok.github.io/Northern-Trust/) |
| **Pacer ETFs** | [paceretfs.com](https://www.paceretfs.com/products/) \| [Pacer](https://daggerok.github.io/Pacer/) |
| **Parametric** | [eatonvance.com](https://www.eatonvance.com/products/etfs.html) \| [Parametric](https://daggerok.github.io/Parametric/) |
| **ProShares** | [proshares.com](https://www.proshares.com/our-etfs/find-proshares-etfs) \| [ProShares](https://daggerok.github.io/ProShares/) |
| **Schwab** | [schwabassetmanagement.com](https://www.schwabassetmanagement.com/products) \| [Schwab](https://daggerok.github.io/Schwab/) |
| **SP Funds** | [sp-funds.com](https://www.sp-funds.com/) \| [SP-Funds](https://daggerok.github.io/SP-Funds/) |
| **SPDR** | [ssga.com](https://www.ssga.com/us/en/intermediary/etfs/fund-finder) \| [SPDR](https://daggerok.github.io/SPDR/) |
| **Sprott ETFs** | [sprottetfs.com](https://sprottetfs.com/) \| [Sprott](https://daggerok.github.io/Sprott/) |
| **Tema ETFs** | [temaetfs.com](https://temaetfs.com/funds) \| [Tema](https://daggerok.github.io/Tema/) |
| **Themes ETFs** | [themesetfs.com/etfs](https://themesetfs.com/etfs) \| [Themes](https://daggerok.github.io/Themes/) |
| **VanEck** | [vaneck.com](https://www.vaneck.com/us/en/etf-mutual-fund-finder/) \| [VanEck](https://daggerok.github.io/VanEck/) |
| **Vanguard** | [investor.vanguard.com](https://investor.vanguard.com/etf/list) \| [Vanguard](https://daggerok.github.io/Vanguard/) |
| **VictoryShares** | [vcm.com VictoryShares ETFs](https://www.vcm.com/products/victoryshares-etfs/victoryshares-etfs-list) \| [VictoryShares](https://daggerok.github.io/VictoryShares/) |
| **WisdomTree** | [wisdomtree.com](https://www.wisdomtree.com/investments) \| [WisdomTree](https://daggerok.github.io/WisdomTree/) |
| **Xtrackers** | [etf.dws.com](https://etf.dws.com/en-us/etf-products/) \| [Xtrackers](https://daggerok.github.io/Xtrackers/) |

## Sibling applications

| Application | Data provider | Repository |
| --- | --- | --- |
| AAM | Official AAM catalog/detail HTML + full holdings XLS + SEC N-PORT holdings fallback + Yahoo market history/dividends | [AAM](https://github.com/daggerok/AAM) |
| abrdn (Aberdeen) | Official Aberdeen gateway + SEC N-PORT holdings fallback + Yahoo history/dividends | [aberdeen](https://github.com/daggerok/aberdeen) |
| Amplify | Amplify ETFs Firestore data feed + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [Amplify](https://github.com/daggerok/Amplify) |
| ARK Invest | ark-funds.com fund pages + overview/NAV-history/performance JSON + official daily holdings CSV + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance distributions/history fallback | [ARK](https://github.com/daggerok/ARK) |
| Capital Group | Official Capital Group fund data + SEC N-PORT holdings fallback + Yahoo history fallback | [Capital-Group](https://github.com/daggerok/Capital-Group) |
| Fidelity | SEC EDGAR N-PORT-P + Yahoo Finance | [Fidelity](https://github.com/daggerok/Fidelity) |
| First Trust | ftportfolios.com official ETF list + fund summary, holdings, distribution and price-history export pages + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history fallback | [First-Trust](https://github.com/daggerok/First-Trust) |
| Franklin Templeton | franklintempleton.com ETF listings + product pages + SEC EDGAR N-PORT-P | [Franklin](https://github.com/daggerok/Franklin) |
| Global X | globalxetfs.com Next.js catalog and fund pages + dated full-holdings CSV | [Global-X](https://github.com/daggerok/Global-X) |
| Goldman Sachs | am.gs.com fund finder + detail pages + SEC EDGAR N-PORT-P | [Goldman-Sachs](https://github.com/daggerok/Goldman-Sachs) |
| Invesco | invesco.com fund pages and sitemap + official Invesco fund API (monthly returns, NAV, AUM, yields, daily holdings, expense ratio) + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [Invesco](https://github.com/daggerok/Invesco) |
| iShares | iShares (BlackRock) product workbooks | [iShares](https://github.com/daggerok/iShares) |
| JPMorgan | am.jpmorgan.com fund explorer + product-data JSON | [JPMorgan](https://github.com/daggerok/JPMorgan) |
| NEOS | neosfunds.com lineup table + official fund pages + daily holdings CSV | [Neos](https://github.com/daggerok/Neos) |
| Northern Trust | etfs.ntam.northerntrust.com funds list + per-fund CSV/JSON downloads | [Northern-Trust](https://github.com/daggerok/Northern-Trust) |
| Pacer ETFs | paceretfs.com product catalog and fund pages (Cloudflare WAF; r.jina.ai proxy fallback) + SEC EDGAR N-PORT-P (Pacer Funds Trust) + Yahoo Finance history/dividends | [Pacer](https://github.com/daggerok/Pacer) |
| Parametric | eatonvance.com ETF catalog and Parametric product pages + SEC EDGAR N-PORT-P holdings + Yahoo Finance history/dividends | [Parametric](https://github.com/daggerok/Parametric) |
| ProShares | proshares.com ETF finder + fund pages + official data host | [ProShares](https://github.com/daggerok/ProShares) |
| Schwab | schwabassetmanagement.com product pages + CSV exports | [Schwab](https://github.com/daggerok/Schwab) |
| SP Funds | sp-funds.com homepage catalog, fund pages and daily holdings CSV + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [SP-Funds](https://github.com/daggerok/SP-Funds) |
| SPDR | SSGA / State Street public feeds | [SPDR](https://github.com/daggerok/SPDR) |
| Sprott ETFs | sprottetfs.com fund pages + SEC EDGAR N-PORT-P (Sprott Funds Trust) + Yahoo Finance history/dividends | [Sprott](https://github.com/daggerok/Sprott) |
| Tema ETFs | Tema official fund pages + dated daily holdings CSV; SEC EDGAR N-PORT-P holdings fallback only + Yahoo Finance price/history/dividend fallback | [Tema](https://github.com/daggerok/Tema) |
| Themes ETFs | themesetfs.com catalog + daily holdings CSV + Yahoo Finance history/dividends + SEC N-PORT-P holdings fallback | [Themes](https://github.com/daggerok/Themes) |
| VanEck | vaneck.com ETF finder + product pages | [VanEck](https://github.com/daggerok/VanEck) |
| Vanguard | Vanguard product pages + SEC EDGAR N-PORT-P | [Vanguard](https://github.com/daggerok/Vanguard) |
| VictoryShares | VCM VictoryShares catalog and product JSON + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance adjusted-market-price history | [VictoryShares](https://github.com/daggerok/VictoryShares) |
| WisdomTree | WisdomTree product table + SEC EDGAR N-PORT-P + Yahoo Finance | [WisdomTree](https://github.com/daggerok/WisdomTree) |
| Xtrackers | Official DWS catalog/US sitemap + PDP/XLSX + SEC N-PORT-P holdings fallback + Yahoo Finance daily prices/history/dividends | [Xtrackers](https://github.com/daggerok/Xtrackers) |

## License

MIT, same as all sibling ETF repositories (see [LICENSE](./LICENSE))

Xtrackers® and DWS® and the fund names/tickers referenced here are trademarks of DWS Group. This is an independent, unofficial tool; it is not affiliated with, endorsed by, or sponsored by DWS or Xtrackers. All data is reproduced from DWS's own public fund pages and downloads, public SEC EDGAR filings and Yahoo Finance for research purposes. All other trademarks, including index names, are the property of their respective owners.
