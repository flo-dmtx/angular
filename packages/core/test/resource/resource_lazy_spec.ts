/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {timeout} from '@angular/private/testing';

import {
  ApplicationRef,
  Component,
  computed,
  effect,
  Injector,
  resource,
  resourceFromSnapshots,
  signal,
  untracked,
} from '../../src/core';
import {TestBed} from '../../testing';

/**
 * Flushes the full lazy lifecycle: runs pending effects (a listener registering), the wake/sleep
 * microtasks, the load effect, and settles resolved loaders.
 */
async function flush(): Promise<void> {
  TestBed.tick();
  await timeout();
  TestBed.tick();
  await timeout();
  TestBed.tick();
}

describe('lazy resource', () => {
  for (const loadStrategy of ['whenTracked', 'whileTracked'] as const) {
    describe(`shared lazy contract (loadStrategy: '${loadStrategy}')`, () => {
      it('should not load at creation', async () => {
        let loads = 0;
        resource({
          loadStrategy,
          params: () => 'a',
          loader: async ({params}) => (loads++, `value:${params}`),
          injector: TestBed.inject(Injector),
        });

        await flush();
        expect(loads).toBe(0);
      });

      it('should not wake from reads outside a reactive context', async () => {
        let loads = 0;
        const echoResource = resource({
          loadStrategy,
          params: () => 'a',
          loader: async ({params}) => (loads++, `value:${params}`),
          injector: TestBed.inject(Injector),
        });

        expect(echoResource.status()).toBe('idle');
        expect(echoResource.value()).toBeUndefined();
        expect(echoResource.error()).toBeUndefined();
        expect(echoResource.isLoading()).toBe(false);
        expect(echoResource.hasValue()).toBe(false);
        expect(echoResource.snapshot()).toEqual({status: 'idle', value: undefined});
        untracked(() => echoResource.value());

        await flush();
        expect(loads).toBe(0);
        expect(echoResource.status()).toBe('idle');
      });

      it('should wake when an effect starts tracking it', async () => {
        let loads = 0;
        const injector = TestBed.inject(Injector);
        const echoResource = resource({
          loadStrategy,
          params: () => 'a',
          loader: async ({params}) => (loads++, `value:${params}`),
          injector,
        });

        const seen: unknown[] = [];
        effect(() => seen.push(echoResource.value()), {injector});
        await flush();

        expect(loads).toBe(1);
        expect(seen).toContain('value:a');
      });

      it('should wake when a template renders it', async () => {
        let loads = 0;
        const injector = TestBed.inject(Injector);
        const echoResource = resource({
          loadStrategy,
          params: () => 'a',
          loader: async ({params}) => (loads++, `value:${params}`),
          injector,
        });

        @Component({template: '{{res.value() ?? "empty"}}'})
        class HostComponent {
          res = echoResource;
        }

        const fixture = TestBed.createComponent(HostComponent);
        fixture.detectChanges();
        await flush();
        fixture.detectChanges();

        expect(loads).toBe(1);
        expect(fixture.nativeElement.textContent).toContain('value:a');
      });

      it('should not deadlock behind a hasValue() guard', async () => {
        const injector = TestBed.inject(Injector);
        const echoResource = resource({
          loadStrategy,
          params: () => 'a',
          loader: async ({params}) => `value:${params}`,
          injector,
        });

        @Component({
          template: '@if (res.hasValue()) {<p>{{res.value()}}</p>} @else {<p>waiting</p>}',
        })
        class GuardedComponent {
          res = echoResource;
        }

        const fixture = TestBed.createComponent(GuardedComponent);
        fixture.detectChanges();
        await flush();
        fixture.detectChanges();

        expect(fixture.nativeElement.textContent).toContain('value:a');
      });

      it('should never fetch params changes while dormant, then use the latest', async () => {
        let loads = 0;
        const request = signal('a');
        const injector = TestBed.inject(Injector);
        const echoResource = resource({
          loadStrategy,
          params: () => request(),
          loader: async ({params}) => (loads++, `value:${params}`),
          injector,
        });

        request.set('b');
        request.set('c');
        await flush();
        expect(loads).toBe(0);

        effect(() => void echoResource.value(), {injector});
        await flush();
        expect(loads).toBe(1);
        expect(echoResource.value()).toBe('value:c');
      });

      it('should react to params changes while tracked', async () => {
        let loads = 0;
        const request = signal('a');
        const injector = TestBed.inject(Injector);
        const echoResource = resource({
          loadStrategy,
          params: () => request(),
          loader: async ({params}) => (loads++, `value:${params}`),
          injector,
        });

        effect(() => void echoResource.value(), {injector});
        await flush();
        expect(echoResource.value()).toBe('value:a');

        request.set('b');
        await flush();
        expect(loads).toBe(2);
        expect(echoResource.value()).toBe('value:b');
      });

      it('should stay dormant behind a computed until a listener reads the computed', async () => {
        let loads = 0;
        const injector = TestBed.inject(Injector);
        const echoResource = resource({
          loadStrategy,
          params: () => 'a',
          loader: async ({params}) => (loads++, `value:${params}`),
          injector,
        });

        const derived = computed(() => echoResource.value() ?? 'empty');

        // A plain read of the computed is still a read outside any live reactive context.
        expect(derived()).toBe('empty');
        await flush();
        expect(loads).toBe(0);

        effect(() => void derived(), {injector});
        await flush();
        expect(loads).toBe(1);
        expect(derived()).toBe('value:a');
      });

      it('should keep a local value set before any listener, without loading', async () => {
        let loads = 0;
        const injector = TestBed.inject(Injector);
        const echoResource = resource({
          loadStrategy,
          params: () => 'a',
          loader: async ({params}) => (loads++, `value:${params}`),
          injector,
        });

        echoResource.set('local');
        expect(echoResource.status()).toBe('local');
        expect(echoResource.value()).toBe('local');

        effect(() => void echoResource.value(), {injector});
        await flush();
        expect(loads).toBe(0);
        expect(echoResource.status()).toBe('local');
      });

      it('should refuse reload() while dormant', async () => {
        let loads = 0;
        const echoResource = resource({
          loadStrategy,
          params: () => 'a',
          loader: async ({params}) => (loads++, `value:${params}`),
          injector: TestBed.inject(Injector),
        });

        expect(echoResource.reload()).toBe(false);
        await flush();
        expect(loads).toBe(0);
        expect(echoResource.status()).toBe('idle');
      });

      it('should surface a rejected loader through the listener', async () => {
        const injector = TestBed.inject(Injector);
        const failingResource = resource({
          loadStrategy,
          params: () => 'a',
          loader: async () => {
            throw new Error('boom');
          },
          injector,
        });

        effect(() => void failingResource.status(), {injector});
        await flush();

        expect(failingResource.status()).toBe('error');
        expect(failingResource.error()?.message).toContain('boom');
        expect(failingResource.hasValue()).toBe(false);
        expect(() => failingResource.value()).toThrow();
      });

      it('should abort the in-flight load when the params change while tracked', async () => {
        let aborts = 0;
        const request = signal('a');
        const injector = TestBed.inject(Injector);
        const echoResource = resource({
          loadStrategy,
          params: () => request(),
          loader: ({abortSignal}) => {
            abortSignal.addEventListener('abort', () => aborts++);
            return new Promise<string>(() => {});
          },
          injector,
        });

        effect(() => void echoResource.status(), {injector});
        await flush();

        request.set('b');
        await flush();
        expect(aborts).toBe(1);
      });

      it('should return the defaultValue while dormant and while loading', async () => {
        const injector = TestBed.inject(Injector);
        const echoResource = resource({
          loadStrategy,
          params: () => 'a',
          loader: () => new Promise<string>(() => {}),
          defaultValue: 'default',
          injector,
        });

        expect(echoResource.value()).toBe('default');

        effect(() => void echoResource.value(), {injector});
        await flush();
        expect(echoResource.status()).toBe('loading');
        expect(echoResource.value()).toBe('default');
      });

      it('should never load once destroyed, even with a listener', async () => {
        let loads = 0;
        const injector = TestBed.inject(Injector);
        const echoResource = resource({
          loadStrategy,
          params: () => 'a',
          loader: async ({params}) => (loads++, `value:${params}`),
          injector,
        });

        echoResource.destroy();
        effect(() => void echoResource.value(), {injector});
        await flush();

        expect(loads).toBe(0);
        expect(echoResource.status()).toBe('idle');
      });

      it('should chain laziness: listening to the parent wakes the chain in order', async () => {
        const order: string[] = [];
        const injector = TestBed.inject(Injector);
        const child = resource({
          loadStrategy,
          params: () => 'c',
          loader: async () => (order.push('child'), 41),
          injector,
        });
        const parent = resource({
          loadStrategy,
          params: ({chain}) => chain(child),
          loader: async ({params}) => (order.push('parent'), params + 1),
          injector,
        });

        await flush();
        expect(order).toEqual([]);

        effect(() => void parent.value(), {injector});
        await flush();
        await flush();

        expect(order).toEqual(['child', 'parent']);
        expect(parent.value()).toBe(42);
      });

      it('should compose through resourceFromSnapshots: listening to the wrapper wakes the source', async () => {
        let loads = 0;
        const injector = TestBed.inject(Injector);
        const sourceResource = resource({
          loadStrategy,
          params: () => 'a',
          loader: async ({params}) => (loads++, `value:${params}`),
          injector,
        });

        const derived = resourceFromSnapshots(sourceResource.snapshot);
        await flush();
        expect(loads).toBe(0);

        effect(() => void derived.value(), {injector});
        await flush();
        expect(loads).toBe(1);
        expect(derived.value()).toBe('value:a');
      });

      it('should keep the application stable while dormant', async () => {
        const appRef = TestBed.inject(ApplicationRef);
        resource({
          loadStrategy,
          params: () => 'a',
          loader: () => new Promise<string>(() => {}),
          injector: TestBed.inject(Injector),
        });

        await expectAsync(appRef.whenStable()).toBeResolved();
      });
    });
  }

  describe("retention (loadStrategy: 'whenTracked')", () => {
    it('should keep the value when the last listener leaves, and not refetch on the next one', async () => {
      let loads = 0;
      const injector = TestBed.inject(Injector);
      const echoResource = resource({
        loadStrategy: 'whenTracked',
        params: () => 'a',
        loader: async ({params}) => (loads++, `value:${params}:${loads}`),
        injector,
      });

      const listener = effect(() => void echoResource.value(), {injector});
      await flush();
      expect(echoResource.value()).toBe('value:a:1');

      listener.destroy();
      await flush();
      expect(echoResource.status()).toBe('resolved');
      expect(echoResource.value()).toBe('value:a:1');

      effect(() => void echoResource.value(), {injector});
      await flush();
      expect(loads).toBe(1);
    });

    it('should defer params changes while untracked to the next listener', async () => {
      let loads = 0;
      const request = signal('a');
      const injector = TestBed.inject(Injector);
      const echoResource = resource({
        loadStrategy: 'whenTracked',
        params: () => request(),
        loader: async ({params}) => (loads++, `value:${params}`),
        injector,
      });

      const listener = effect(() => void echoResource.value(), {injector});
      await flush();
      listener.destroy();
      await flush();

      request.set('b');
      await flush();
      expect(loads).toBe(1);

      effect(() => void echoResource.value(), {injector});
      await flush();
      expect(loads).toBe(2);
      expect(echoResource.value()).toBe('value:b');
    });
  });

  describe("reset (loadStrategy: 'whileTracked')", () => {
    it('should drop the value and return to idle when the last listener leaves', async () => {
      let loads = 0;
      const injector = TestBed.inject(Injector);
      const echoResource = resource({
        loadStrategy: 'whileTracked',
        params: () => 'a',
        loader: async ({params}) => (loads++, `value:${params}:${loads}`),
        injector,
      });

      const listener = effect(() => void echoResource.value(), {injector});
      await flush();
      expect(echoResource.value()).toBe('value:a:1');

      listener.destroy();
      await flush();
      expect(echoResource.status()).toBe('idle');
      expect(echoResource.value()).toBeUndefined();

      effect(() => void echoResource.value(), {injector});
      await flush();
      expect(loads).toBe(2);
      expect(echoResource.value()).toBe('value:a:2');
    });

    it('should cancel the in-flight load and forget when abandoned mid-load', async () => {
      let loads = 0;
      let aborts = 0;
      const injector = TestBed.inject(Injector);
      const echoResource = resource({
        loadStrategy: 'whileTracked',
        params: () => 'a',
        loader: ({abortSignal}) => {
          loads++;
          abortSignal.addEventListener('abort', () => aborts++);
          return new Promise<string>(() => {});
        },
        injector,
      });

      const listener = effect(() => void echoResource.status(), {injector});
      await flush();
      expect(loads).toBe(1);

      listener.destroy();
      await flush();
      expect(aborts).toBe(1);
      expect(echoResource.status()).toBe('idle');
    });

    it('should keep the value while at least one listener remains', async () => {
      let loads = 0;
      const injector = TestBed.inject(Injector);
      const echoResource = resource({
        loadStrategy: 'whileTracked',
        params: () => 'a',
        loader: async ({params}) => (loads++, `value:${params}`),
        injector,
      });

      const first = effect(() => void echoResource.value(), {injector});
      effect(() => void echoResource.status(), {injector});
      await flush();
      expect(echoResource.value()).toBe('value:a');

      first.destroy();
      await flush();
      expect(echoResource.status()).toBe('resolved');
      expect(echoResource.value()).toBe('value:a');
      expect(loads).toBe(1);
    });

    it('should also drop a local value on abandon', async () => {
      let loads = 0;
      const injector = TestBed.inject(Injector);
      const echoResource = resource({
        loadStrategy: 'whileTracked',
        params: () => 'a',
        loader: async ({params}) => (loads++, `value:${params}`),
        injector,
      });

      echoResource.set('local');
      const listener = effect(() => void echoResource.value(), {injector});
      await flush();
      expect(echoResource.status()).toBe('local');
      expect(loads).toBe(0);

      listener.destroy();
      await flush();
      expect(echoResource.status()).toBe('idle');
      expect(echoResource.value()).toBeUndefined();
    });

    it('should re-derive a params error after abandon instead of blanking it', async () => {
      const injector = TestBed.inject(Injector);
      const failingResource = resource({
        loadStrategy: 'whileTracked',
        params: (): string => {
          throw new Error('bad params');
        },
        loader: async ({params}) => `value:${params}`,
        injector,
      });

      const listener = effect(() => void failingResource.status(), {injector});
      await flush();
      expect(failingResource.status()).toBe('error');

      // Forgetting recomputes the state from the current params: the error is not a load
      // result, it derives from the params themselves, so abandoning does not erase it.
      listener.destroy();
      await flush();
      expect(failingResource.status()).toBe('error');
      expect(failingResource.error()?.message).toBe('bad params');
    });
  });

  describe('eager loading', () => {
    it('should load eagerly when loadStrategy is not set', async () => {
      let loads = 0;
      resource({
        params: () => 'a',
        loader: async ({params}) => (loads++, `value:${params}`),
        injector: TestBed.inject(Injector),
      });

      TestBed.tick();
      expect(loads).toBe(1);
    });

    it("should load eagerly when loadStrategy is explicitly 'eager'", async () => {
      let loads = 0;
      resource({
        loadStrategy: 'eager',
        params: () => 'a',
        loader: async ({params}) => (loads++, `value:${params}`),
        injector: TestBed.inject(Injector),
      });

      TestBed.tick();
      expect(loads).toBe(1);
    });
  });
});
