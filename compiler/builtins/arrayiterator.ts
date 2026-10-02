import type {} from './porffor.d.ts';

export const __Porffor_ArrayIterator_create =  (array: any, kind: i32): __Porffor_ArrayIterator => {
  const out: __Porffor_ArrayIterator = Porffor.malloc(16);
  Porffor.IR.storeJv(out, 0, array);
  Porffor.IR.storeI32(out, 8, 0);
  Porffor.IR.storeI32(out, 12, kind);
  return out;
};

export const __Porffor_ArrayIterator_prototype_$$toStringTag = "Array Iterator";

// https://tc39.es/ecma262/#sec-%arrayiteratorprototype%.next
export const __Porffor_ArrayIterator_prototype_next = function (this: __Porffor_ArrayIterator, value: any): object {
  if (Porffor.type(this) != Porffor.TYPES.__porffor_arrayiterator) {
    throw new TypeError('Method Array Iterator.prototype.next called on incompatible receiver ' + this);
  }

  const array: any = Porffor.IR.loadJv(this, 0);

  if (Porffor.type(array) == Porffor.TYPES.undefined) return __Porffor_iterResult(undefined, true);

  const index: i32 = Porffor.IR.loadI32(this, 8);

  const len: i32 = array.length;

  if (index >= len) {
    // completed: later calls stay done even if array grows
    Porffor.IR.storeJv(this, 0, undefined);
    return __Porffor_iterResult(undefined, true);
  }

  Porffor.IR.storeI32(this, 8, index + 1);

  const kind: i32 = Porffor.IR.loadI32(this, 12);
  if (kind == 0) return __Porffor_iterResult(index, false);

  const elementValue: any = array[index];

  if (kind == 1) return __Porffor_iterResult(elementValue, false);

  // not a literal: array literals in precompiled builtins are static, shared between calls
  const entry: any[] = Porffor.array.new(2);
  Porffor.array.fastPush(entry, index);
  Porffor.array.fastPush(entry, elementValue);
  return __Porffor_iterResult(entry, false);

};
