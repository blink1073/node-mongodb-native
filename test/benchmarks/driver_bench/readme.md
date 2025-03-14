# Node.js Driver Benchmarks

Set up the driver for development (`npm ci` in the top level of this repo).

Then:

```sh
npm start
```

will build the benchmarks and run them.

## Environment Configuration and Setup

The benchmarks respond to a few environment variables:

- `MONGODB_URI`
  - The connection string to run operations against.
    CI uses a standalone, you should be able to launch any cluster and point the benchmarks at it via this env var.
  - default: `"mongodb://localhost:27017"`
- `MONGODB_DRIVER_PATH`
  - The path to the MongoDB Node.js driver.
    This MUST be set to the _directory_ the driver is installed in.
    **NOT** the file "lib/index.js" that is the driver's export.
  - default: 4 directories above driver.mjs (should be the root of this repo)
- `MONGODB_CLIENT_OPTIONS`
  - A JSON string that will be passed to the MongoClient constructor
  - default: `"{}"`

## Running individual benchmarks

`main.mjs` loops and launches the bench runner for you.

You can launch `runner.mjs` directly and tell it which benchmark to run.

```sh
node lib/runner.mjs suites/multi_bench/grid_fs_upload.mjs
```

## Writing your own benchmark

In the suites directory you can add a new suite folder or add a new `.mts` file to an existing one.

A benchmark must export the following:

```ts
type BenchmarkModule = {
  taskSize: number;
  before?: () => Promise<void>;
  beforeEach?: () => Promise<void>;
  run: () => Promise<void>;
  afterEach?: () => Promise<void>;
  after?: () => Promise<void>;

  tags?: string[];
};
```

Just like mocha we have once before and once after as well as before each and after each hooks.

The `driver.mts` module is intended to hold various helpers for setup and teardown and help abstract some of the driver API.

## Benchmark tags
The `tags` property of `BenchmarkModule` is where a benchmark's tags should be added to facilitate
performance alerting and filter of results via our internal tools.

Tags are defined in `driver.mts` under the `TAG` enum.
Whenever a new tag is defined it should be documented in the table below .

| tag variable name |    tag string value    |                                                               purpose                                                                |
|-------------------|------------------------|--------------------------------------------------------------------------------------------------------------------------------------|
|     `TAG.spec`    | `'spec-benchmark'`     | Special tag that marks a benchmark as a spec-required benchmark                                                                      |
|     `TAG.alert`   | `'alerting-benchmark'` | Special tag that enables our perf monitoring tooling to create alerts when regressions in this benchmark's performance are detected  |
|     `TAG.cursor`  | `'cursor-benchmark'`   | Tag marking a benchmark as being related to cursor performance                                                                       |
|     `TAG.read`    | `'read-benchmark'`     | Tag marking a benchmark as being related to read performance                                                                         |
|     `TAG.write`   | `'write-benchmark'`    | Tag marking a benchmark as being related to write performance                                                                        |

## Wishlist

- Make it so runner can handle: `./lib/suites/multi_bench/grid_fs_upload.mjs` as an argument so shell path autocomplete makes it easier to pick a benchmark
- Make `main.mjs` accept a filter of some kind to run some of the benchmarks
- TBD
