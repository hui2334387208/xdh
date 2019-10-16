import * as http from 'http';
import * as net from 'net';
import { NodeModule } from './node-module';
import { WebSocketServerRoute, WebSocketHandler, WSChannel } from '@ali/ide-connection';
import { Injector, ClassCreator } from '@ali/common-di';
import { getLogger } from '@ali/ide-core-common';
import * as ws from 'ws';

import {
  CommonChannelHandler,
  commonChannelPathHandler,

  initRPCService,
  RPCServiceCenter,
  createWebSocketConnection,
  createSocketConnection,
} from '@ali/ide-connection';

export {RPCServiceCenter};

const logger = getLogger();
const serviceInjectorMap = new Map();
const clientServerConnectionMap = new Map();
const clientServiceCenterMap = new Map();

export function createServerConnection2(server: http.Server, injector, modulesInstances, handlerArr?: WebSocketHandler[]) {
  const socketRoute = new WebSocketServerRoute(server, logger);
  const channelHandler = new CommonChannelHandler('/service', logger);

  // 事件由 connection 的时机来触发
  commonChannelPathHandler.register('RPCService', {
      handler: (connection: WSChannel, clientId: string) => {
        logger.log(`set rpc connection ${clientId}`);

        // if (serviceInjectorMap.has(clientId)) {
        //   logger.log(`set already rpc connection ${clientId}`);
        //   return;
        // }

        const serviceCenter = new RPCServiceCenter();
        const serverConnection = createWebSocketConnection(connection);
        connection.messageConnection = serverConnection;
        serviceCenter.setConnection(serverConnection);

        // 服务链接创建
        const serviceChildInjector = bindModuleBackService(injector, modulesInstances, serviceCenter, clientId);
        serviceInjectorMap.set(clientId, serviceChildInjector);
        clientServerConnectionMap.set(clientId, serverConnection);
        clientServiceCenterMap.set(clientId, serviceCenter);
        console.log('serviceInjectorMap', serviceInjectorMap.keys());

        connection.onClose(() => {
          // 删除对应后台到前台逻辑
          serviceCenter.removeConnection(serverConnection);

          serviceChildInjector.disposeAll();

          serviceInjectorMap.delete(clientId);
          clientServerConnectionMap.delete(clientId);
          clientServiceCenterMap.delete(clientId);
          console.log(`remove rpc connection ${clientId} `);

        });
      },
      // reconnect: (connection: ws, connectionClientId: string) => {

      // },
      dispose: (connection: ws, connectionClientId: string) => {
        // logger.log('remove rpc serverConnection');
        // if (connection) {
        //   serviceCenter.removeConnection(connection.messageConnection);
        // }

        /* FIXME: 临时先不删除调用对象
        if (clientServerConnectionMap.has(connectionClientId)) {
          const removeResult = (clientServiceCenterMap.get(connectionClientId) as any).removeConnection(
            clientServerConnectionMap.get(connectionClientId),
          );

          console.log(`${connectionClientId} remove rpc connection`, removeResult);
        }
        */

        /*
        if (serviceInjectorMap.has(connectionClientId)) {
          const inejctor = serviceInjectorMap.get(connectionClientId) as Injector;

        }
        */

      },
  });

  socketRoute.registerHandler(channelHandler);
  if (handlerArr) {
    for (const handler of handlerArr) {
      socketRoute.registerHandler(handler);
    }
  }
  socketRoute.init();

  // return serviceCenter;
}

export function createNetServerConnection(server: net.Server, injector, modulesInstances) {

  const serviceCenter = new RPCServiceCenter();

  let serverConnection;
  bindModuleBackService(injector, modulesInstances, serviceCenter, process.env.CODE_WINDOW_CLIENT_ID as string);
  function createConnectionDispose(connection, serverConnection) {
    connection.on('close', () => {
      serviceCenter.removeConnection(serverConnection);
    });
  }
  server.on('connection', (connection) => {
    logger.log(`set net rpc connection`);
    serverConnection = createSocketConnection(connection);
    serviceCenter.setConnection(serverConnection);

    createConnectionDispose(connection, serverConnection);
  });

  return serviceCenter;

}

export function bindModuleBackService(injector: Injector, modules: NodeModule[], serviceCenter: RPCServiceCenter, clientId?: string) {

  const {
    createRPCService,
  } = initRPCService(serviceCenter);

  const childInjector = injector.createChild();
  for (const module of modules) {
    if (module.backServices) {
      for (const service of module.backServices) {
        if (service.token) {
          logger.log('back service', service.token);
          const serviceToken = service.token;

          if (!injector.creatorMap.get(serviceToken)) {
            continue;
          }
          const serviceClass = (injector.creatorMap.get(serviceToken) as ClassCreator).useClass;

          childInjector.addProviders({
            token: serviceToken,
            useClass: serviceClass,
          });
          const serviceInstance = childInjector.get(serviceToken);

          if (serviceInstance.setConnectionClientId && clientId) {
            serviceInstance.setConnectionClientId(clientId);
          }
          const servicePath = service.servicePath;
          const createService = createRPCService(servicePath, serviceInstance);

          if (!serviceInstance.rpcClient) {
            serviceInstance.rpcClient = [createService];
          }
        }
      }
    }
  }

  return childInjector;
}
