import { fork, spawn } from 'node:child_process';
import { on, once } from 'node:events';
import { openSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { inspect } from 'node:util';

import { AssertionError, expect } from 'chai';
import type * as timers from 'timers';
import { parseSnapshot } from 'v8-heapsnapshot';

import type * as mongodb from '../../mongodb';
import { type MongoClient } from '../../mongodb';
import { type TestConfiguration } from '../../tools/runner/config';
import { type sleep } from '../../tools/utils';

export type ResourceTestFunction = HeapResourceTestFunction | ProcessResourceTestFunction;

export type HeapResourceTestFunction = (options: {
  MongoClient: typeof MongoClient;
  uri: string;
  iteration: number;
}) => Promise<void>;

export type ProcessResourceTestFunction = (options: {
  MongoClient: typeof MongoClient;
  uri?: string;
  log?: (out: any) => void;
  expect: typeof expect;
  mongodb?: typeof mongodb;
  sleep?: typeof sleep;
  getTimerCount?: () => number;
  timers?: typeof timers;
  getSocketReport?: () => { host: string; port: string };
  getSocketEndpointReport?: () => any;
  once?: () => typeof once;
}) => Promise<void>;

const HEAP_RESOURCE_SCRIPT_PATH = path.resolve(
  __dirname,
  '../../tools/fixtures/heap_resource_script.in.js'
);
const REPORT_RESOURCE_SCRIPT_PATH = path.resolve(
  __dirname,
  '../../tools/fixtures/process_resource_script.in.js'
);
const DRIVER_SRC_PATH = JSON.stringify(path.resolve(__dirname, '../../../lib'));

export async function testScriptFactory(
  name: string,
  uri: string,
  resourceScriptPath: string,
  func: ResourceTestFunction,
  iterations?: number
) {
  let resourceScript = await readFile(resourceScriptPath, { encoding: 'utf8' });

  resourceScript = resourceScript.replace('DRIVER_SOURCE_PATH', DRIVER_SRC_PATH);
  resourceScript = resourceScript.replace('FUNCTION_STRING', `(${func.toString()})`);
  resourceScript = resourceScript.replace('SCRIPT_NAME_STRING', JSON.stringify(name));
  resourceScript = resourceScript.replace('URI_STRING', JSON.stringify(uri));
  resourceScript = resourceScript.replace('ITERATIONS_STRING', `${iterations}`);

  return resourceScript;
}

/**
 * A helper for running arbitrary MongoDB Driver scripting code in a resource information collecting script.
 * This script uses heap data to collect resource information.
 *
 * **The provided function is run in an isolated Node.js process**
 *
 * A user of this function will likely need to familiarize themselves with the surrounding scripting, but briefly:
 * - Every MongoClient you construct should have an asyncResource attached to it like so:
 * ```js
 * mongoClient.asyncResource = new this.async_hooks.AsyncResource('MongoClient');
 * ```
 * - You can perform any number of operations and connects/closes of MongoClients
 * - The result of this function will be:
 *   - the startup and teardown memory usage
 *   - the number of AsyncResources with type === 'MongoClient' that did not get cleaned up by a destroy hook
 *   - the heap snapshot parsed by 'v8-heapsnapshot'
 *
 * @param name - the name of the script, this defines the name of the file, it will be cleaned up if the function returns successfully
 * @param config - `this.configuration` from your mocha config
 * @param func - your javascript function, you can write it inline! this will stringify the function, use the references on the `this` context to get typechecking
 * @param options - settings for the script
 * @throws Error - if the process exits with failure
 */
export async function runScriptAndReturnHeapInfo(
  name: string,
  config: TestConfiguration,
  func: HeapResourceTestFunction,
  { iterations = 100 } = {}
) {
  const log = (...args) => {
    const payload =
      args
        .map(item =>
          typeof item === 'string'
            ? item
            : inspect(item, { depth: Infinity, breakLength: Infinity })
        )
        .join(', ') + '\n';
    process.stdout.write(payload);
  };
  log('starting');
  const scriptName = `${name}.cjs`;
  const heapsnapshotFile = `${name}.heapsnapshot.json`;

  const scriptContent = await testScriptFactory(
    name,
    config.url(),
    HEAP_RESOURCE_SCRIPT_PATH,
    func,
    iterations
  );
  await writeFile(scriptName, scriptContent, { encoding: 'utf8' });

  const processDiedController = new AbortController();
  const script = fork(scriptName, { execArgv: ['--expose-gc'], stdio: 'inherit' });
  // Interrupt our awaiting of messages if the process crashed
  script.once('close', exitCode => {
    if (exitCode !== 0) {
      log('process exited with non-zero: ', exitCode);
      processDiedController.abort(new Error(`process exited with: ${exitCode}`));
    }
  });

  script.once('error', error => {
    log(`processed errored: ${error}`);
    processDiedController.abort(new Error(`process errored: `, { cause: error }));
  });

  script.once('spawn', () => log('script spawned successfully.'));

  const messages = on(script, 'message', { signal: processDiedController.signal });
  const willClose = once(script, 'close');

  log('fetching messages 1...');
  const starting = await messages.next();
  log('fetching messages 2: ', starting);

  const ending = await messages.next();

  log('fetching messages 3: ', ending);

  const startingMemoryUsed = starting.value[0].startingMemoryUsed;
  const endingMemoryUsed = ending.value[0].endingMemoryUsed;

  // make sure the process ended
  const [exitCode] = await willClose;

  log('child process closed.');

  expect(exitCode, 'process should have exited with zero').to.equal(0);

  const heap = await readFile(heapsnapshotFile, { encoding: 'utf8' }).then(c =>
    parseSnapshot(JSON.parse(c))
  );

  log('done.');

  // If any of the above throws we won't reach these unlinks that clean up the created files.
  // This is intentional so that when debugging the file will still be present to check it for errors
  await unlink(scriptName);
  await unlink(heapsnapshotFile);

  return {
    startingMemoryUsed,
    endingMemoryUsed,
    heap
  };
}

/**
 * A helper for running arbitrary MongoDB Driver scripting code in a resource information collecting script.
 * This script uses info from node:process to collect resource information.
 *
 * **The provided function is run in an isolated Node.js process**
 *
 * A user of this function will likely need to familiarize themselves with the surrounding scripting, but briefly:
 * - Many MongoClient operations (construction, connection, commands) can result in resources that keep the JS event loop running.
 *   - Timers
 *   - Active Sockets
 *   - File Read Hangs
 *
 * - This function performs assertions that at the end of the provided function, the js event loop has been exhausted
 *
 * @param name - the name of the script, this defines the name of the file, it will be cleaned up if the function returns successfully
 * @param config - `this.configuration` from your mocha config
 * @param func - your javascript function, you can write it inline! this will stringify the function, use the references on the `this` context to get typechecking
 * @param options - settings for the script
 * @throws Error - if the process exits with failure or if the process' resources are not cleaned up by the provided function.
 */
export async function runScriptAndGetProcessInfo(
  name: string,
  config: TestConfiguration,
  func: ProcessResourceTestFunction
) {
  const scriptName = `${name}.cjs`;
  const scriptContent = await testScriptFactory(
    name,
    config.url(),
    REPORT_RESOURCE_SCRIPT_PATH,
    func
  );

  const logFile = name + '.logs.txt';
  const stdErrFile = 'err.out';

  await unlink(scriptName).catch(() => null);
  await unlink(logFile).catch(() => null);
  await unlink(stdErrFile).catch(() => null);

  await writeFile(scriptName, scriptContent, { encoding: 'utf8' });

  const script = spawn(process.execPath, [scriptName], {
    stdio: ['ignore', 'ignore', openSync(stdErrFile, 'w')]
  });

  const willClose = once(script, 'close');

  // make sure the process ended
  const [exitCode] = (await willClose) as [number];

  // format messages from child process as an object
  const messages = (await readFile(logFile, 'utf-8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));

  const stdErr = await readFile(stdErrFile, { encoding: 'utf8' });

  // delete temporary files
  await unlink(scriptName);
  await unlink(logFile);
  await unlink(stdErrFile);

  // assertions about exit status
  if (exitCode) {
    const { error } = messages.find(m => m.error != null);
    expect(error, 'test script exited with non-zero exit code but did not report an error.').to
      .exist;
    const assertionError = new AssertionError(
      error.message + '\n\t' + JSON.stringify(error.resources, undefined, 2)
    );
    assertionError.stack = error.stack + new Error().stack.slice('Error'.length);
    throw assertionError;
  }

  // assertions about resource status
  const { beforeExitHappened } = messages.find(m => 'beforeExitHappened' in m);
  const { newResources } = messages.find(m => 'newResources' in m);

  expect(beforeExitHappened).to.be.true;
  expect(newResources.libuvResources).to.be.empty;
  expect(newResources.activeResources).to.be.empty;

  // assertion about error output
  expect(stdErr).to.be.empty;
}
