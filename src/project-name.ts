export function validProjectName(name: string): boolean {
  return Boolean(name) && Buffer.byteLength(name) <= 255 && !name.startsWith('.') && !name.startsWith(' ') &&
    !/[. ]$/.test(name) && !/[\\/\u0000-\u001f\u007f-\u009f<>:"|?*]/.test(name) && name.toLowerCase() !== 'node_modules';
}

