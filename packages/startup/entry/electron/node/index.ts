import { startServer } from './server';
import { FileServiceModule } from '@ali/ide-file-service/lib/node';
import { DocModelModule } from '@ali/ide-doc-model/lib/node';
import { FeatureExtensionServerModule } from '@ali/ide-feature-extension';
import { VSCodeExtensionServerModule } from '@ali/ide-vscode-extension';

import { ProcessModule } from '@ali/ide-process';

import { SearchModule } from '@ali/ide-search';
import { WorkspaceModule } from '@ali/ide-workspace/lib/node';
import { Terminal2Module } from '@ali/ide-terminal2';
import { ExtensionStorageModule } from '@ali/ide-extension-storage/lib/node';
import { StorageModule } from '@ali/ide-storage/lib/node';
import { LogServiceModule } from '@ali/ide-logs/lib/node';

startServer({
  modules: [
    LogServiceModule,
    FileServiceModule,
    DocModelModule,
    FeatureExtensionServerModule,
    VSCodeExtensionServerModule,
    ProcessModule,
    SearchModule,
    WorkspaceModule,
    Terminal2Module,
    ExtensionStorageModule,
    StorageModule,
  ],
}).then(() => {
  if (process.send) {
    process.send('ready');
  }
});
