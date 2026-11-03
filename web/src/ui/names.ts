/** `base.ext`, or `base-2.ext`, `base-3.ext`, … when that name is already taken (a RAW/JPEG pair, two folders). */
export function uniqueName(base: string, ext: string, taken: (name: string) => boolean): string {
  let name = `${base}${ext}`;
  for (let n = 2; taken(name); n++) name = `${base}-${n}${ext}`;
  return name;
}
