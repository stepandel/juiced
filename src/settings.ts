/** The personal defaults Juiced can change through Claude's headless menus. */
export type SavedSettings = {
  model?: string;
  permissionMode?: string;
  effortLevel?: string;
  outputStyle?: string;
  fastMode?: boolean;
};

export function validateSavedSettings(value: SavedSettings): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length ||
      Object.entries(value).some(([key, setting]) => {
        if (key === 'fastMode') return typeof setting !== 'boolean';
        if (typeof setting !== 'string' || !setting || setting.length > 256 || /[\x00-\x1f\x7f-\x9f]/u.test(setting)) return true;
        if (key === 'model') return /\s/u.test(setting);
        if (key === 'permissionMode') return !['default', 'acceptEdits', 'plan', 'dontAsk'].includes(setting);
        if (key === 'effortLevel') return !/^[a-z]+$/u.test(setting);
        return key !== 'outputStyle';
      })) throw new Error('Invalid saved settings');
}
