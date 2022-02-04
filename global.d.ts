import type { TestConfiguration } from './test/tools/runner/config';

type WithExclusion<T extends string> = `!${T}`
/** Defined in test/tools/runner/filters/mongodb_topology_filter.js (topologyTypeToString) */
type TopologyTypes = 'single' | 'replicaset' | 'sharded' | 'load-balanced';
type TopologyTypeRequirement = WithExclusion<TopologyTypes> | WithExclusion<TopologyTypes>[]

interface MongoDBMetadataUI {
  requires?: {
    topology?: TopologyTypeRequirement;
    mongodb?: string;
    os?: NodeJS.Platform | `!${NodeJS.Platform}`;
    apiVersion?: '1';
    clientSideEncryption?: boolean;
    serverless?: 'forbid' | 'allow' | 'require';
  };

  sessions?: {
    skipLeakTests?: boolean;
  };
}

interface MetadataAndTest<Fn> {
  metadata: MongoDBMetadataUI;
  test: Fn;
}

declare global {
  namespace Mocha {
    interface TestFunction {
      (title: string, metadata: MongoDBMetadataUI, fn: Mocha.Func): Mocha.Test;
      (title: string, metadata: MongoDBMetadataUI, fn: Mocha.AsyncFunc): Mocha.Test;

      (title: string, testAndMetadata: MetadataAndTest<Mocha.Func>): Mocha.Test;
      (title: string, testAndMetadata: MetadataAndTest<Mocha.AsyncFunc>): Mocha.Test;
    }

    interface Context {
      configuration: TestConfiguration;
    }

    interface Test {
      metadata: MongoDBMetadataUI;
    }

    interface Runnable {
      /**
       * An optional string the test author can attach to print out why a test is skipped
       *
       * @example
       * ```
       * it.skip('my test', () => {
       *   //...
       * }).skipReason = 'TODO(NODE-XXXX): Feature implementation impending!';
       * ```
       *
       * The reporter (`test/tools/reporter/mongodb_reporter.js`) will print out the skipReason
       * indented directly below the test name.
       * ```
       * - my test
       *   - TODO(NODE-XXXX): Feature implementation impending!
       * ```
       *
       * You can also skip a set of tests via beforeEach:
       * ```
       * beforeEach(() => {
       *   if ('some condition') {
       *     this.currentTest.skipReason = 'requires <run condition> to run';
       *     this.skip();
       *   }
       * });
       * ```
       */
      skipReason?: string;
    }
  }
}