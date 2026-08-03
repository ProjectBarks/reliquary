/**
 * Thin TypeScript port of the Godot traversal wrappers from the original
 * companion's scry layer (decomp/scry/deobfuscated.js ~6799-6898). These wrap
 * the raw objects the native `GodotScry`/`DotNetCoreScry` return so reader code
 * can walk the live scene tree ergonomically.
 *
 * Everything past the native boundary is untyped, so these are deliberately
 * loose (`any`); the reader layer on top adds the real shapes.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export class GodotContext {
  constructor(
    public godot: any,
    public dotnet: any
  ) {}

  getClass(className: string): GodotObject {
    return new GodotObject(this.dotnet.getClass(className), this.godot, this.dotnet)
  }
}

export class GodotObject {
  constructor(
    public obj: any,
    private godot: any,
    private dotnet: any
  ) {}

  get(key: string): any {
    return asGodotValue(this.obj.get(key), this.godot, this.dotnet)
  }
  getBaseAddress(): any {
    return this.obj.getBaseAddress()
  }
  getClassName(): string {
    return this.obj.getClassName()
  }
  getFieldValue(key: string): any {
    return asGodotValue(this.obj.getFieldValue(key), this.godot, this.dotnet)
  }
  getNode(baseAddress: any): GodotNode {
    return new GodotNode(this.godot.getNode(baseAddress), this.godot, this.dotnet)
  }
  getControl(baseAddress: any): any {
    return this.godot.getControl(baseAddress)
  }
  getLabel(baseAddress: any): any {
    return this.godot.getLabel(baseAddress)
  }
  getRichTextLabel(baseAddress: any): any {
    return this.godot.getRichTextLabel(baseAddress)
  }
}

export class GodotNode {
  constructor(
    public node: any,
    private godot: any,
    private dotnet: any
  ) {}

  getChildren(): GodotNode[] {
    return this.node
      .getChildren()
      .map((child: any) => new GodotNode(child, this.godot, this.dotnet))
  }
  getName(): string {
    return this.node.getName()
  }
  getParent(): GodotNode | null {
    const parent = this.node.getParent()
    if (parent === null) return null
    return new GodotNode(parent, this.godot, this.dotnet)
  }
  getDotNetCoreObject(): GodotObject | null {
    const obj = this.node.getDotNetCoreObject(this.dotnet)
    return obj ? new GodotObject(obj, this.godot, this.dotnet) : null
  }
  castControl(): any {
    return this.godot.getControl(this.node.getBaseAddress())
  }
}

export class GodotArray {
  constructor(
    private array: any,
    private godot: any,
    private dotnet: any
  ) {}

  at(index: number): any {
    return asGodotValue(this.array.at(index), this.godot, this.dotnet)
  }
  get length(): number {
    return this.array.length
  }
}

export function asGodotValue(value: any, godot: any, dotnet: any): any {
  if (value === null || value === undefined) return value
  if (typeof value === 'object') {
    if ('at' in value && 'length' in value) return new GodotArray(value, godot, dotnet)
    return new GodotObject(value, godot, dotnet)
  }
  return value
}
