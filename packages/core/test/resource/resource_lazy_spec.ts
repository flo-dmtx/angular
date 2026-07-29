/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {timeout} from '@angular/private/testing';

import {ApplicationRef, Component, computed, Injector, resource, signal} from '../../src/core';
import {TestBed} from '../../testing';

describe('lazy resource', () => {
  it('should not load at creation and should load on the first read', async () => {
    let loads = 0;
    const echoResource = resource({
      lazy: true,
      params: () => 'a',
      loader: async ({params}) => (loads++, `value:${params}`),
      injector: TestBed.inject(Injector),
    });

    TestBed.tick();
    expect(loads).toBe(0);

    expect(echoResource.status()).toBe('loading');
    expect(loads).toBe(1);
    expect(echoResource.value()).toBeUndefined();

    await timeout();
    expect(echoResource.status()).toBe('resolved');
    expect(echoResource.value()).toBe('value:a');
  });

  it('should wake from a read of any of its signals', () => {
    const reads = {
      'value': (res: {value(): unknown}) => res.value(),
      'status': (res: {status(): unknown}) => res.status(),
      'error': (res: {error(): unknown}) => res.error(),
      'isLoading': (res: {isLoading(): unknown}) => res.isLoading(),
      'hasValue': (res: {hasValue(): unknown}) => res.hasValue(),
      'snapshot': (res: {snapshot(): unknown}) => res.snapshot(),
    };

    for (const [name, read] of Object.entries(reads)) {
      let loads = 0;
      const echoResource = resource({
        lazy: true,
        params: () => 'a',
        loader: async ({params}) => (loads++, `value:${params}`),
        injector: TestBed.inject(Injector),
      });

      read(echoResource);
      expect(loads).withContext(`waking read: ${name}`).toBe(1);
    }
  });

  it('should not load on params changes while unread, then should use the latest params', async () => {
    let loads = 0;
    const request = signal('a');
    const echoResource = resource({
      lazy: true,
      params: () => request(),
      loader: async ({params}) => (loads++, `value:${params}`),
      injector: TestBed.inject(Injector),
    });

    request.set('b');
    request.set('c');
    TestBed.tick();
    expect(loads).toBe(0);

    expect(echoResource.status()).toBe('loading');
    await timeout();
    expect(loads).toBe(1);
    expect(echoResource.value()).toBe('value:c');
  });

  it('should not reload when re-read with unchanged params', async () => {
    let loads = 0;
    const echoResource = resource({
      lazy: true,
      params: () => 'a',
      loader: async ({params}) => (loads++, `value:${params}`),
      injector: TestBed.inject(Injector),
    });

    echoResource.status();
    await timeout();

    expect(echoResource.value()).toBe('value:a');
    expect(echoResource.value()).toBe('value:a');
    expect(loads).toBe(1);
  });

  it('should react to params changes after waking', async () => {
    let loads = 0;
    const request = signal('a');
    const echoResource = resource({
      lazy: true,
      params: () => request(),
      loader: async ({params}) => (loads++, `value:${params}`),
      injector: TestBed.inject(Injector),
    });

    echoResource.status();
    await timeout();
    expect(echoResource.value()).toBe('value:a');

    request.set('b');
    expect(echoResource.status()).toBe('loading');
    expect(loads).toBe(2);
    await timeout();
    expect(echoResource.value()).toBe('value:b');
  });

  it('should keep updating a template that reads it when the params change', async () => {
    @Component({template: '{{res.value() ?? "empty"}}'})
    class Reader {
      loads = 0;
      readonly request = signal('a');
      readonly res = resource({
        lazy: true,
        params: () => this.request(),
        loader: async ({params}) => (this.loads++, `value:${params}`),
      });
    }

    const fixture = TestBed.createComponent(Reader);
    const reader = fixture.componentInstance;
    const appRef = TestBed.inject(ApplicationRef);

    // Rendering is the first read: it wakes the resource, and `whenStable` awaits the load.
    await appRef.whenStable();
    expect(fixture.nativeElement.textContent).toContain('value:a');
    expect(reader.loads).toBe(1);

    // With a live reader, a params change re-loads without any manual read.
    reader.request.set('b');
    await appRef.whenStable();
    expect(fixture.nativeElement.textContent).toContain('value:b');
    expect(reader.loads).toBe(2);
  });

  it('should keep the application stable while unread', async () => {
    let loads = 0;
    resource({
      lazy: true,
      params: () => 'a',
      // A loader that never resolves: if it ran, `whenStable` would never settle.
      loader: () => (loads++, new Promise<string>(() => {})),
      injector: TestBed.inject(Injector),
    });

    await TestBed.inject(ApplicationRef).whenStable();
    expect(loads).toBe(0);
  });

  it('should resolve during the waking read when the stream settles synchronously', () => {
    const echoResource = resource({
      lazy: true,
      params: () => 'a',
      stream: ({params}) => signal({value: `value:${params}`}),
      injector: TestBed.inject(Injector),
    });

    // The load starts before the state is read, so a synchronous stream is already resolved
    // within the very read that woke the resource.
    expect(echoResource.status()).toBe('resolved');
    expect(echoResource.value()).toBe('value:a');
  });

  it('should return the defaultValue from the read that wakes it', async () => {
    let loads = 0;
    const echoResource = resource({
      lazy: true,
      params: () => 'a',
      loader: async ({params}) => (loads++, `value:${params}`),
      defaultValue: 'placeholder',
      injector: TestBed.inject(Injector),
    });

    expect(echoResource.value()).toBe('placeholder');
    expect(loads).toBe(1);

    await timeout();
    expect(echoResource.value()).toBe('value:a');
  });

  it('should stay idle while the params are undefined and load once they are set', async () => {
    let loads = 0;
    const request = signal<string | undefined>(undefined);
    const echoResource = resource({
      lazy: true,
      params: () => request(),
      loader: async ({params}) => (loads++, `value:${params}`),
      injector: TestBed.inject(Injector),
    });

    expect(echoResource.status()).toBe('idle');
    expect(loads).toBe(0);

    request.set('a');
    expect(echoResource.status()).toBe('loading');
    await timeout();
    expect(echoResource.value()).toBe('value:a');
    expect(loads).toBe(1);
  });

  it('should abort the in-flight load when the params change', () => {
    const aborted: string[] = [];
    const request = signal('a');
    const echoResource = resource({
      lazy: true,
      params: () => request(),
      loader: ({params, abortSignal}) => {
        abortSignal.addEventListener('abort', () => aborted.push(params));
        return new Promise<string>(() => {});
      },
      injector: TestBed.inject(Injector),
    });

    echoResource.status();
    request.set('b');
    echoResource.status();

    expect(aborted).toEqual(['a']);
  });

  it('should surface a rejected loader through error, status, hasValue and value', async () => {
    const echoResource = resource({
      lazy: true,
      params: () => 'a',
      loader: async () => {
        throw new Error('fail');
      },
      injector: TestBed.inject(Injector),
    });

    // `error()` is itself a waking read.
    expect(echoResource.error()).toBeUndefined();
    await timeout();

    expect(echoResource.status()).toBe('error');
    expect(echoResource.error()).toEqual(new Error('fail'));
    expect(echoResource.hasValue()).toBeFalse();
    expect(() => echoResource.value()).toThrow();
  });

  it('should never load when set() is called before any read', () => {
    let loads = 0;
    const echoResource = resource({
      lazy: true,
      params: () => 'a',
      loader: async ({params}) => (loads++, `value:${params}`),
      injector: TestBed.inject(Injector),
    });

    echoResource.set('local value');
    TestBed.tick();

    expect(echoResource.status()).toBe('local');
    expect(echoResource.value()).toBe('local value');
    expect(loads).toBe(0);
  });

  it('should not load when equal set() calls deduplicate before any read', () => {
    let loads = 0;
    const echoResource = resource({
      lazy: true,
      params: () => 'a',
      loader: async () => (loads++, ['fetched']),
      equal: (a, b) => a.join() === b.join(),
      injector: TestBed.inject(Injector),
    });

    echoResource.set(['local']);
    // The deduplication reads the current value, which is a pull — it must not start a load.
    echoResource.set(['local']);

    expect(echoResource.status()).toBe('local');
    expect(loads).toBe(0);
  });

  it('should replace a local value with a fresh load when the params change', async () => {
    let loads = 0;
    const request = signal('a');
    const echoResource = resource({
      lazy: true,
      params: () => request(),
      loader: async ({params}) => (loads++, `value:${params}`),
      injector: TestBed.inject(Injector),
    });

    echoResource.set('local value');
    request.set('b');

    expect(echoResource.status()).toBe('loading');
    await timeout();
    expect(echoResource.value()).toBe('value:b');
    expect(loads).toBe(1);
  });

  it('should not initiate a load from reload() before any read', async () => {
    let loads = 0;
    const echoResource = resource({
      lazy: true,
      params: () => 'a',
      loader: async ({params}) => (loads++, `value:${params}`),
      injector: TestBed.inject(Injector),
    });

    expect(echoResource.reload()).toBe(false);
    TestBed.tick();
    expect(loads).toBe(0);

    // The resource still wakes normally on its actual first read.
    echoResource.status();
    await timeout();
    expect(echoResource.value()).toBe('value:a');
    expect(loads).toBe(1);
  });

  it('should defer the load requested by reload() to the next read', async () => {
    let loads = 0;
    const echoResource = resource({
      lazy: true,
      params: () => 'a',
      loader: async ({params}) => (loads++, `value:${params}:${loads}`),
      injector: TestBed.inject(Injector),
    });

    echoResource.status();
    await timeout();
    expect(echoResource.value()).toBe('value:a:1');

    expect(echoResource.reload()).toBe(true);
    // Without a live reader, nothing loads until the next read...
    expect(loads).toBe(1);

    // ...and the next read starts the reload, keeping the previous value meanwhile.
    expect(echoResource.status()).toBe('reloading');
    expect(loads).toBe(2);
    expect(echoResource.value()).toBe('value:a:1');

    await timeout();
    expect(echoResource.status()).toBe('resolved');
    expect(echoResource.value()).toBe('value:a:2');
  });

  it('should leave a destroyed resource idle without ever loading', () => {
    let loads = 0;
    const echoResource = resource({
      lazy: true,
      params: () => 'a',
      loader: async ({params}) => (loads++, `value:${params}`),
      injector: TestBed.inject(Injector),
    });

    echoResource.destroy();

    expect(echoResource.status()).toBe('idle');
    expect(loads).toBe(0);
  });

  it('should not load when the params change after destroy()', () => {
    let loads = 0;
    const request = signal('a');
    const echoResource = resource({
      lazy: true,
      params: () => request(),
      loader: async ({params}) => (loads++, `value:${params}`),
      injector: TestBed.inject(Injector),
    });

    echoResource.destroy();
    request.set('b');

    expect(echoResource.status()).toBe('idle');
    expect(loads).toBe(0);
  });

  it('should abort the in-flight load when destroyed after waking', () => {
    const aborted: string[] = [];
    const echoResource = resource({
      lazy: true,
      params: () => 'a',
      loader: ({params, abortSignal}) => {
        abortSignal.addEventListener('abort', () => aborted.push(params));
        return new Promise<string>(() => {});
      },
      injector: TestBed.inject(Injector),
    });

    echoResource.status();
    echoResource.destroy();

    expect(aborted).toEqual(['a']);
    expect(echoResource.status()).toBe('idle');
  });

  it('should stay asleep behind a computed until the computed itself is read', async () => {
    let loads = 0;
    const echoResource = resource({
      lazy: true,
      params: () => 'a',
      loader: async ({params}) => (loads++, `value:${params}`),
      injector: TestBed.inject(Injector),
    });
    // Computeds are lazily evaluated, so laziness chains: declaring a derivation over the
    // resource wakes nothing; only reading the derivation does.
    const derived = computed(() => echoResource.value()?.toUpperCase());

    TestBed.tick();
    expect(loads).toBe(0);

    expect(derived()).toBeUndefined();
    expect(loads).toBe(1);
    await timeout();
    expect(derived()).toBe('VALUE:A');
  });

  it('should chain laziness through ctx.chain', async () => {
    let childLoads = 0;
    const child = resource({
      lazy: true,
      params: () => 'child',
      loader: async ({params}) => (childLoads++, `${params}-value`),
      injector: TestBed.inject(Injector),
    });
    const parent = resource({
      lazy: true,
      params: (ctx) => ctx.chain(child),
      loader: async ({params}) => `parent of ${params}`,
      injector: TestBed.inject(Injector),
    });

    TestBed.tick();
    expect(childLoads).toBe(0);

    // Reading the parent wakes the chained child through the params function.
    expect(parent.status()).toBe('loading');
    expect(childLoads).toBe(1);

    await timeout();
    expect(parent.status()).toBe('loading');
    await timeout();
    expect(parent.value()).toBe('parent of child-value');
  });

  it('should propagate a chained child error to the lazy parent', async () => {
    const child = resource({
      lazy: true,
      params: () => 'child',
      loader: async () => {
        throw new Error('child failed');
      },
      injector: TestBed.inject(Injector),
    });
    const parent = resource({
      lazy: true,
      params: (ctx) => ctx.chain(child),
      loader: async ({params}) => `parent of ${params}`,
      injector: TestBed.inject(Injector),
    });

    expect(parent.status()).toBe('loading');
    await timeout();

    expect(parent.status()).toBe('error');
    expect(child.status()).toBe('error');
  });

  it('should load eagerly when lazy is not set', async () => {
    let loads = 0;
    resource({
      params: () => 'a',
      loader: async ({params}) => (loads++, `value:${params}`),
      injector: TestBed.inject(Injector),
    });

    TestBed.tick();
    expect(loads).toBe(1);
  });

  it('should load eagerly when lazy is explicitly false', async () => {
    let loads = 0;
    resource({
      lazy: false,
      params: () => 'a',
      loader: async ({params}) => (loads++, `value:${params}`),
      injector: TestBed.inject(Injector),
    });

    TestBed.tick();
    expect(loads).toBe(1);
  });
});
