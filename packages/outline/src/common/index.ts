import { MarkerSeverity, URI } from '@ali/ide-core-common';
import { ITreeNode } from '@ali/ide-components';

export const enum OutlineSortOrder {
  ByPosition,
  ByName,
  ByKind,
}

export interface IOutlineMarker {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  severity: MarkerSeverity;
  message?: string;
}

export const IOutlineDecorationService = Symbol('IOutlineDecorationService');

export interface IOutlineDecoration {
  color: string;
  tooltip: string;
  badge: string;
}

export interface IOutlineDecorationService {
  getDecoration(node: ITreeNode): IOutlineDecoration;
  updateDiagnosisInfo(uri?: URI): void;
}
