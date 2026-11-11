import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LanguageModel } from '../../extension/src/offline/model';

export function loadModelFromDisk(root: string): LanguageModel {
  return LanguageModel.parse(readFileSync(join(root, 'shared', 'model', 'en.model.txt'), 'utf8'));
}
