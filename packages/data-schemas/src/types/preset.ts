/**
 * A preset as the preset methods read and write it: a plain record, not the mongoose document
 * of `~/schema/preset`. Fields beyond the ones named are the conversation settings it saves.
 */
export interface PresetRecord {
  user?: string;
  presetId?: string;
  order?: number;
  defaultPreset?: boolean;
  tools?: (string | { pluginKey?: string })[];
  updatedAt?: Date;
  [key: string]: unknown;
}
