/**
 * Test harness that executes the generated, injected Plasticity scripts against fake native objects.
 * The scripts are plain `async function (...bindings, ...values)` declarations that run with the editor as `this`;
 * this mirrors `PlasticityRuntime.call` (Runtime.callFunctionOn) without a renderer.
 */
export type WriteLog = Array<[property: string, value: unknown]>;

export interface FakeFactoryRecord {
  /** Property writes in order, as seen by the script. */
  writes: WriteLog;
  /** Method calls in order. */
  calls: Array<[method: string, args: unknown[]]>;
  constructed: number;
  committed: number;
}

/** Evaluates a generated script declaration and calls it the way the runtime does. */
export async function runInjectedScript(
  source: string,
  bindingNames: string[],
  values: unknown[],
  bindings: Record<string, unknown>,
  editor: object,
): Promise<unknown> {
  const fn = new Function(`return (${source});`)() as (...args: unknown[]) => Promise<unknown>;
  // The runtime passes values and returns results by JSON (returnByValue); mirror that so native objects do not leak through.
  values = JSON.parse(JSON.stringify(values)) as unknown[];
  const args = [...bindingNames.map((name) => {
    if (!(name in bindings)) throw new Error(`Plasticity native binding is unavailable: ${name}`);
    return bindings[name];
  }), ...values];
  const result = await fn.apply(editor, args);
  return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
}

export interface FakeFactoryOptions {
  record: FakeFactoryRecord;
  /** Extra prototype members, for example addVariationPoint. */
  members?: Record<string, (this: unknown, ...args: any[]) => unknown>;
  onCommit?: (factory: Record<string, unknown>) => void | Promise<void>;
}

export function newFactoryRecord(): FakeFactoryRecord {
  return { writes: [], calls: [], constructed: 0, committed: 0 };
}

/** A factory class whose property writes and method calls are recorded. */
export function createFakeFactory(options: FakeFactoryOptions): new (editor: unknown) => Record<string, unknown> {
  const { record } = options;
  class Base {
    constructor(_editor: unknown) {
      record.constructed += 1;
      return new Proxy(this, {
        set(target, property, value) {
          record.writes.push([String(property), value]);
          (target as Record<string | symbol, unknown>)[property] = value;
          return true;
        },
      });
    }
    resource(_command: unknown) { return this; }
    async commit() {
      record.committed += 1;
      await options.onCommit?.(this as unknown as Record<string, unknown>);
    }
  }
  for (const [name, member] of Object.entries(options.members ?? {})) {
    Object.defineProperty(Base.prototype, name, {
      value: function (this: unknown, ...args: unknown[]) {
        record.calls.push([name, args]);
        return member.apply(this, args);
      },
      configurable: true,
      writable: true,
    });
    // Preserve the declared arity of the original member: wrappers report length 0.
    Object.defineProperty((Base.prototype as unknown as Record<string, Function>)[name]!, "length", { value: member.length });
  }
  return Base as unknown as new (editor: unknown) => Record<string, unknown>;
}

export interface FakeEdge {
  id: string;
  entityId: number;
  /** Native point at parameter t in 0..1, metres. */
  at: (t: number) => { x: number; y: number; z: number };
}

export interface FakeEditorOptions {
  bodyId: number;
  edges: FakeEdge[];
  commands?: Record<string, new (editor: unknown) => object>;
  busy?: boolean;
}

/** An editor with geo.geometryModel, db.lookupStableId, commands, executor and exec. */
export function createFakeEditor(options: FakeEditorOptions): Record<string, unknown> {
  const versionId = 1000 + options.bodyId;
  const edgeViews = options.edges.map((edge) => ({ entityId: edge.entityId, id: edge.id }));
  const item = {
    view: {
      high: {
        edges: {
          versionIds: options.edges.map((edge) => edge.id),
          get: (index: number) => edgeViews[index],
        },
      },
    },
    model: {
      GetEdges: () => ({
        Size: () => options.edges.length,
        Get: (index: number) => ({
          Id: () => options.edges[index]!.entityId,
          GetPointAndTangent: (t: number) => ({ position: options.edges[index]!.at(t), tangent: { x: 1, y: 0, z: 0 } }),
        }),
      }),
    },
  };
  const commands = options.commands ?? {
    FilletShellCommand: class { remember = true; execute: () => Promise<unknown> = async () => undefined; },
  };
  return {
    geo: { geometryModel: new Map([[versionId, item]]) },
    db: { lookupStableId: (id: number) => (id === versionId ? options.bodyId : -1) },
    executor: { isBusy: options.busy === true },
    commands,
    exec: async (command: { execute: () => Promise<unknown> }) => { await command.execute(); },
  };
}
