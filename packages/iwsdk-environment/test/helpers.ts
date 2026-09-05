/**
 * A structural fake IWSDK world.
 *
 * `@iwsdk/core` imports cleanly in node - it is the ECS and the three.js
 * bindings, not a renderer - so the adapter runs against REAL component
 * definitions, a real `three.Scene` and real `Quaternion` maths here. Only the
 * world and its entities are faked, because building one needs a canvas.
 *
 * That split is deliberate: a fake that also faked `DomeGradient` would let a
 * misspelled field name pass, which is precisely the bug an adapter is most
 * likely to have.
 */
// three.js comes through @iwsdk/core here, not from "three" directly: IWSDK
// ships its own pinned @types/three, and a Scene built from the other copy is
// a structurally different type that will not fit `world.scene`.
import { Scene } from "@iwsdk/core";
import type { Object3D } from "@iwsdk/core";

export interface FakeEntity {
  readonly id: number;
  readonly components: Map<unknown, Record<string, unknown>>;
  readonly vectors: Map<string, Float32Array>;
  readonly object3D: Object3D | undefined;
  parent: FakeEntity | undefined;
  destroyed: boolean;
  hasComponent(component: unknown): boolean;
  addComponent(component: unknown, values?: Record<string, unknown>): FakeEntity;
  removeComponent(component: unknown): FakeEntity;
  setValue(component: unknown, key: string, value: unknown): void;
  getValue(component: unknown, key: string): unknown;
  getVectorView(component: unknown, key: string): Float32Array;
  destroy(): void;
}

/** Stable per-component keys, so two components never share a vector slot. */
const componentIds = new WeakMap<object, number>();
let nextComponentId = 1;

function keyOf(component: unknown, field: string): string {
  const object = component as object;
  let id = componentIds.get(object);
  if (id === undefined) {
    id = nextComponentId;
    nextComponentId += 1;
    componentIds.set(object, id);
  }
  return `${id}:${field}`;
}

let nextEntityId = 1;

export function createFakeEntity(object3D?: Object3D): FakeEntity {
  const entity: FakeEntity = {
    id: nextEntityId++,
    components: new Map(),
    vectors: new Map(),
    object3D,
    parent: undefined,
    destroyed: false,
    hasComponent(component) {
      return this.components.has(component);
    },
    addComponent(component, values = {}) {
      this.components.set(component, { ...values });
      return this;
    },
    removeComponent(component) {
      this.components.delete(component);
      return this;
    },
    setValue(component, key, value) {
      const bag = this.components.get(component);
      if (bag === undefined) throw new Error("setValue on a component the entity lacks");
      bag[key] = value;
    },
    getValue(component, key) {
      return this.components.get(component)?.[key];
    },
    getVectorView(component, key) {
      const id = keyOf(component, key);
      let view = this.vectors.get(id);
      if (view === undefined) {
        view = new Float32Array(4);
        this.vectors.set(id, view);
      }
      return view;
    },
    destroy() {
      this.destroyed = true;
    },
  };
  return entity;
}

export interface FakeWorld {
  readonly scene: Scene;
  activeLevel: { value: FakeEntity | null };
  readonly created: FakeEntity[];
  readonly registeredSystems: unknown[];
  createTransformEntity(object?: Object3D, options?: { parent?: FakeEntity }): FakeEntity;
  registerSystem(system: unknown): void;
}

export function createFakeWorld(options: { withLevel?: boolean } = {}): FakeWorld {
  const created: FakeEntity[] = [];
  return {
    scene: new Scene(),
    activeLevel: { value: options.withLevel === false ? null : createFakeEntity() },
    created,
    registeredSystems: [],
    createTransformEntity(object, entityOptions) {
      const entity = createFakeEntity(object);
      entity.parent = entityOptions?.parent;
      created.push(entity);
      return entity;
    },
    registerSystem(system) {
      this.registeredSystems.push(system);
    },
  };
}

/** The adapters take the real `World` type; tests hand them this instead. */
export function asWorld(world: FakeWorld): never {
  return world as never;
}
