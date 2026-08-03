/**
 * Typed-access layer over the raw Godot wrappers in ./godot.ts.
 *
 * Ported from the original companion's scry bundle (decomp/scry ~1298-1538,
 * 3234-3305, 7448-7508). `ScryObject` sits on top of a `GodotObject` (whose
 * `.get()` already returns asGodotValue-wrapped children) and adds runtime type
 * checks so readers can walk the live scene tree with confidence. Everything
 * past the native boundary is untyped, so `obj` is deliberately `any`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export class ScryError extends Error {}

function isScryArrayLike(obj: any): boolean {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    !Array.isArray(obj) &&
    obj.at !== undefined &&
    obj.length !== undefined
  )
}

function getTypeName(obj: any): string {
  if (isScryArrayLike(obj)) return 'array'
  return typeof obj
}

export interface ItemCtor<T> {
  new (obj: any): T
}

export class ScryObject {
  constructor(public obj: any) {}

  unsafe(key: string): any {
    return this.obj.get(key)
  }

  object(key: string, nullable?: boolean): any {
    const value = this.obj.get(key)
    if (value === null || value === undefined) {
      if (nullable) return null
      throw new ScryError(`${key} is null`)
    }
    if (typeof value !== 'object') {
      throw new ScryError(`${key} is not a valid object, actual type is ${getTypeName(value)}`)
    }
    if (isScryArrayLike(value)) {
      throw new ScryError(`${key} is not a valid object, actual type is array`)
    }
    return value
  }

  array<T = any>(key: string, opts?: { nullable?: boolean; itemCtor?: ItemCtor<T> }): ScryArray<T> | null {
    const value = this.obj.get(key)
    if (value === null || value === undefined) {
      if (opts?.nullable) return null
      throw new ScryError(`${key} is null`)
    }
    if (!isScryArrayLike(value)) {
      throw new ScryError(`${key} is not a valid array, actual type is ${getTypeName(value)}`)
    }
    return new ScryArray<T>(value, opts?.itemCtor)
  }

  boolean(key: string, nullable?: boolean): boolean | null {
    const value = this.obj.get(key)
    if (value === null || value === undefined) {
      if (nullable) return null
      throw new ScryError(`${key} is null`)
    }
    if (typeof value !== 'boolean') {
      throw new ScryError(`${key} is not a valid boolean, actual type is ${getTypeName(value)}`)
    }
    return value
  }

  string(key: string, nullable?: boolean): string | null {
    const value = this.obj.get(key)
    if (value === null || value === undefined) {
      if (nullable) return null
      throw new ScryError(`${key} is null`)
    }
    if (typeof value !== 'string') {
      throw new ScryError(`${key} is not a valid string, actual type is ${getTypeName(value)}`)
    }
    return value
  }

  number(key: string, nullable?: boolean): number | null {
    const value = this.obj.get(key)
    if (value === null || value === undefined) {
      if (nullable) return null
      throw new ScryError(`${key} is null`)
    }
    if (typeof value !== 'number') {
      throw new ScryError(`${key} is not a valid number, actual type is ${getTypeName(value)}`)
    }
    return value
  }

  cast<T>(ctor: ItemCtor<T>): T {
    return new ctor(this.obj)
  }

  get baseAddress(): any {
    return this.obj.getBaseAddress()
  }

  private _className?: string
  get className(): string {
    if (this._className === undefined) {
      this._className =
        'getClassName' in this.obj ? this.obj.getClassName() : 'Unknown'
    }
    return this._className as string
  }
}

export class ScryArray<T = any> {
  private _length?: number
  constructor(
    private arr: any,
    private itemCtor?: ItemCtor<T>
  ) {}

  get length(): number {
    if (this._length === undefined) this._length = this.arr.length
    return this._length as number
  }

  at(index: number): T | undefined {
    if (index < 0 || index >= this.length) return undefined
    const value = this.arr.at(index)
    if (this.itemCtor && value !== null && value !== undefined) {
      return new this.itemCtor(value)
    }
    return value
  }

  [Symbol.iterator](): Iterator<T | undefined> {
    let i = 0
    const length = this.length
    return {
      next: () => ({ done: i >= length, value: this.at(i++) })
    }
  }
}

export class List<T = any> extends ScryObject {
  length: number
  private itemCtor?: ItemCtor<T>
  private _itemsVersion = -1
  private _items?: ScryArray<T>

  constructor(obj: any, itemCtor?: ItemCtor<T>) {
    super(obj)
    this.length = this.number('_size') as number
    this.itemCtor = itemCtor
  }

  get version(): number {
    return this.number('_version') as number
  }

  get items(): ScryArray<T> {
    const version = this.version
    if (!this._items || this._itemsVersion !== version) {
      this._itemsVersion = version
      this._items = this.array<T>('_items', { itemCtor: this.itemCtor }) as ScryArray<T>
    }
    return this._items
  }

  at(index: number): T | undefined {
    if (index < 0 || index >= this.length) return undefined
    return this.items.at(index)
  }

  last(): T | undefined {
    return this.at(this.length - 1)
  }

  map<R>(fn: (item: T | undefined, i: number) => R): R[] {
    const result: R[] = []
    for (let i = 0; i < this.length; i++) result.push(fn(this.at(i), i))
    return result
  }

  [Symbol.iterator](): Iterator<T | undefined> {
    let i = 0
    return { next: () => ({ done: i >= this.length, value: this.at(i++) }) }
  }
}

export class Stack<T = any> extends ScryObject {
  count: number
  private itemCtor?: ItemCtor<T>
  private _itemsVersion = -1
  private _items?: ScryArray<T>

  constructor(obj: any, itemCtor?: ItemCtor<T>) {
    super(obj)
    this.count = this.number('_size') as number
    this.itemCtor = itemCtor
  }

  get version(): number {
    return this.number('_version') as number
  }

  get items(): ScryArray<T> {
    const version = this.version
    if (!this._items || this._itemsVersion !== version) {
      this._itemsVersion = version
      this._items = this.array<T>('_array', { itemCtor: this.itemCtor }) as ScryArray<T>
    }
    return this._items
  }

  at(index: number): T | undefined {
    if (index < 0 || index >= this.count) return undefined
    return this.items.at(index)
  }

  [Symbol.iterator](): Iterator<T | undefined> {
    let i = 0
    return { next: () => ({ done: i >= this.count, value: this.at(i++) }) }
  }
}

export class ScryGodotObject extends ScryObject {
  private _nativePtr?: number
  get NativePtr(): number {
    if (this._nativePtr === undefined) this._nativePtr = this.number('NativePtr') as number
    return this._nativePtr
  }

  getNode(): any {
    return this.obj.getNode(this.NativePtr)
  }
  getControl(): any {
    return this.obj.getControl(this.NativePtr)
  }
  /** The control's on-screen size in game pixels: [width, height]. */
  getSize(): [number, number] {
    return this.getControl().getSize()
  }
  /**
   * Sum each control's local offset up the tree until a fullscreen ancestor (the
   * origin), yielding a global position in game pixels. Ported from the original
   * scry layer: getGlobalPosition() reads Godot's cached global transform which
   * can go stale for nodes positioned via GlobalPosition writes; local offsets
   * are always current.
   */
  computeGlobalPosition(
    screenSize: [number, number],
    cached?: (addr: any, fn: () => any) => any
  ): [number, number] {
    const memo = cached ?? ((_addr: any, fn: () => any): any => fn())
    let x = 0
    let y = 0
    let current: any = this.getNode()
    for (let depth = 0; current && depth < 32; depth++) {
      try {
        const control = current.castControl()
        const [lx, ly] = control.getPosition()
        if (lx === 0 && ly === 0) {
          const isFullscreen = memo(control.getBaseAddress(), () => {
            const size = control.getSize()
            return size[0] >= screenSize[0] && size[1] >= screenSize[1]
          })
          if (isFullscreen) break
        } else {
          x += lx
          y += ly
        }
        current = current.getParent()
      } catch {
        break
      }
    }
    return [x, y]
  }
  getLabelText(): string {
    try {
      return this.obj.getLabel(this.NativePtr).getText()
    } catch {
      return ''
    }
  }
  getRichLabelText(): string {
    try {
      return this.obj.getRichTextLabel(this.NativePtr).getText()
    } catch {
      return ''
    }
  }
}

/**
 * Read a static field from a class object (obtained via GodotContext.getClass),
 * asserting it is present. Mirrors the original's getValid/getValidOrNull from
 * the MonoObjectHelpers sibling bundle (only the surface we use).
 */
export function getValid(classObj: any, key: string, type?: string): any {
  const value = classObj.get(key)
  if (value === null || value === undefined) throw new ScryError(`${key} is null`)
  if (type && typeof value !== type) {
    throw new ScryError(`${key} is not a ${type}`)
  }
  return value
}

export function getValidOrNull(classObj: any, key: string, type?: string): any {
  try {
    const value = classObj.get(key)
    if (value === null || value === undefined) return null
    if (type && typeof value !== type) return null
    return value
  } catch {
    return null
  }
}
