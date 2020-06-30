import { Injectable, Autowired, Injector, INJECTOR_TOKEN } from '@ali/common-di';
import { Event, formatLocalize, IProblemMatcherRegistry, Disposable, Deferred, ProblemMatcher, isString, deepClone, removeAnsiEscapeCodes, Emitter, DisposableCollection } from '@ali/ide-core-common';

import { ITaskSystem, ITaskExecuteResult, ITaskExecutor, TaskExecuteKind, IActivateTaskExecutorData, TaskTerminateResponse } from '../common';
import { Task, ContributedTask, CommandString, CommandConfiguration, TaskEvent, TaskEventKind } from '../common/task';
import { TerminalOptions, ITerminalController, ITerminalGroupViewService, ITerminalClient, ITerminalService, ITerminalClientFactory } from '@ali/ide-terminal-next/lib/common';
import { CustomTask } from '../common/task';
import { IVariableResolverService } from '@ali/ide-variable';
import { ProblemCollector } from './problem-collector';
import { Path } from '@ali/ide-core-common/lib/path';

enum TaskStatus {
  PROCESS_INIT,
  PROCESS_READY,
  PROCESS_RUNNING,
  PROCESS_EXITED,
}

@Injectable({ multiple: true })
export class TerminalTaskExecutor extends Disposable implements ITaskExecutor {

  @Autowired(ITerminalGroupViewService)
  protected readonly terminalView: ITerminalGroupViewService;

  @Autowired(ITerminalController)
  protected readonly terminalController: ITerminalController;

  @Autowired(ITerminalService)
  protected readonly terminalService: ITerminalService;

  @Autowired(ITerminalClientFactory)
  protected readonly clientFactory: ITerminalClientFactory;

  private terminalClient: ITerminalClient;

  private pid: number | undefined;

  private exitDefer: Deferred<{ exitCode?: number }> = new Deferred();

  private _onDidTaskProcessExit: Emitter<number | undefined> = new Emitter();

  private _onDidTerminalWidgetRemove: Emitter<void> = new Emitter();

  public onDidTerminalWidgetRemove: Event<void> = this._onDidTerminalWidgetRemove.event;

  public onDidTaskProcessExit: Event<number | undefined> = this._onDidTaskProcessExit.event;

  public processReady: Deferred<void> = new Deferred<void>();

  private processExited: boolean = false;

  private disposableCollection: DisposableCollection = new DisposableCollection();

  public taskStatus: TaskStatus = TaskStatus.PROCESS_INIT;

  constructor(
    private terminalOptions: TerminalOptions,
    private collector: ProblemCollector,
    public executorId: number,
  ) {
    super();

    this.addDispose(this.terminalView.onWidgetDisposed((e) => {
      if (this.terminalClient && e.id === this.terminalClient.id) {
        this._onDidTerminalWidgetRemove.fire();
      }
    }));
  }

  terminate(): Promise<{ success: boolean }> {
    return new Promise((resolve) => {
      if (this.terminalClient) {
        this.terminalClient.dispose();
        if (this.processExited) {
          // 如果在调 terminate 之前进程已经退出，直接删掉 terminalWidget 即可
          this.terminalView.removeWidget(this.terminalClient.id);
          resolve({ success: true });
        } else {
          this.terminalService.onExit((e) => {
            if (e.sessionId === this.terminalClient.id) {
              this.terminalView.removeWidget(this.terminalClient.id);
              resolve({ success: true });
            }
          });
        }
      } else {
        resolve({ success: true });
      }
    });
  }

  private onTaskExit(code?: number) {
    const { term, id } = this.terminalClient;
    term.setOption('disableStdin', true);
    term.writeln(formatLocalize('terminal.integrated.exitedWithCode', code));
    term.writeln(`\r\n\x1b[1m${formatLocalize('reuseTerminal')}\x1b[0m`);
    this._onDidTaskProcessExit.fire(code);
    this.disposableCollection.push(term.onKey(() => {
      this.terminalView.removeWidget(id);
    }));
  }

  private createTerminal(reuse?: boolean) {
    if (reuse) {
      this.terminalClient.updateOptions(this.terminalOptions);
      this.terminalClient.reset();
    } else {
      this.terminalClient = this.terminalController.createClientWithWidget({ ...this.terminalOptions, closeWhenExited: false });
    }
    this.terminalController.showTerminalPanel();

    this.addDispose(this.terminalClient.onOutput((e) => {
      this.collector.processLine(removeAnsiEscapeCodes(e.data.toString()));
    }));

    this.disposableCollection.push(this.terminalService.onExit((e) => {
      if (e.sessionId === this.terminalClient.id) {
        this.onTaskExit(e.code);
        this.processExited = true;
        this.taskStatus = TaskStatus.PROCESS_EXITED;
        this.exitDefer.resolve({ exitCode: e.code });
      }
    }));
  }

  async execute(task: Task, reuse?: boolean): Promise<{ exitCode?: number }> {
    this.taskStatus = TaskStatus.PROCESS_READY;
    this.createTerminal(reuse);

    this.terminalClient.term.writeln(`\x1b[1m> Executing task: ${task._label} <\x1b[0m\n`);
    const { shellArgs } = this.terminalOptions;
    this.terminalClient.term.writeln(`\x1b[1m> Command: ${typeof shellArgs === 'string' ? shellArgs : shellArgs![1]} <\x1b[0m\n`);

    await this.terminalClient.attached.promise;
    this.pid = await this.terminalClient.pid;
    this.taskStatus = TaskStatus.PROCESS_RUNNING;

    this.processReady.resolve();
    this.terminalView.selectWidget(this.terminalClient.id);
    this.terminalClient.term.write('\n\x1b[G');
    return this.exitDefer.promise;
  }

  get processId(): number | undefined {
    return this.pid;
  }

  get widgetId(): string | undefined {
    return this.terminalClient && this.terminalClient.widget.id;
  }

  public updateTerminalOptions(terminalOptions: TerminalOptions) {
    this.terminalOptions = terminalOptions;
  }

  public updateProblemCollector(collector: ProblemCollector) {
    this.collector = collector;
  }

  public reset() {
    this.disposableCollection.dispose();
    this.taskStatus = TaskStatus.PROCESS_INIT;
  }
}

@Injectable()
export class TerminalTaskSystem extends Disposable implements ITaskSystem {

  @Autowired(INJECTOR_TOKEN)
  private readonly injector: Injector;

  @Autowired(IProblemMatcherRegistry)
  problemMatcher: IProblemMatcherRegistry;

  @Autowired(IVariableResolverService)
  variableResolver: IVariableResolverService;

  private executorId: number = 0;

  protected currentTask: Task;

  private activeTaskExecutors: Map<string, IActivateTaskExecutorData> = new Map();

  private _onDidStateChange: Emitter<TaskEvent> = new Emitter();

  private taskExecutors: TerminalTaskExecutor[] = [];

  onDidStateChange: Event<TaskEvent> = this._onDidStateChange.event;

  run(task: CustomTask | ContributedTask): Promise<ITaskExecuteResult> {
    this.currentTask = task;
    return this.executeTask(task);
  }

  private async buildShellConfig(command: CommandConfiguration) {
    let subCommand: string = '';
    const commandName = command.name;
    const commandArgs = command.args;
    const subArgs: string[] = [];
    const result: string[] = [];

    if (commandName) {
      if (typeof commandName === 'string') {
        subCommand = commandName;
      } else {
        subCommand = commandName.value;
      }
    }

    subArgs.push(subCommand);

    if (commandArgs) {
      for (const arg of commandArgs) {
        if (typeof arg === 'string') {
          subArgs.push(arg);
        } else {
          subArgs.push(arg.value);
        }
      }
    }

    for (const arg of subArgs) {
      if (arg.indexOf(Path.separator) > -1) {
        result.push(await this.resolveVariables(arg.split(Path.separator)));
      } else {
        result.push(await this.resolveVariable(arg));
      }
    }
    return { shellArgs: ['-c', `${result.join(' ')}`] };
  }

  private findAvaiableExecutor(): TerminalTaskExecutor | undefined {
    return this.taskExecutors.find((e) => e.taskStatus === TaskStatus.PROCESS_EXITED);
  }

  private async executeTask(task: CustomTask | ContributedTask): Promise<ITaskExecuteResult> {
    this._onDidStateChange.fire(TaskEvent.create(TaskEventKind.Start, task));
    const matchers = await this.resolveMatchers(task.configurationProperties.problemMatchers);
    const collector = new ProblemCollector(matchers);
    const { shellArgs } = await this.buildShellConfig(task.command);
    const terminalOptions: TerminalOptions = {
      name: this.createTerminalName(task),
      shellArgs,
      env: task.command.options?.env || {},
      cwd: task.command.options?.cwd ? await this.resolveVariable(task.command.options?.cwd) : await this.resolveVariable('${workspaceFolder}'),
    };

    this._onDidStateChange.fire(TaskEvent.create(TaskEventKind.Active, task));
    let executor: TerminalTaskExecutor | undefined = this.findAvaiableExecutor();
    let reuse = false;
    if (!executor) {
      executor = this.injector.get(TerminalTaskExecutor, [terminalOptions, collector, this.executorId]);
      this.executorId += 1;
      this.taskExecutors.push(executor);
      this.addDispose(executor.onDidTerminalWidgetRemove(() => {
        this.taskExecutors = this.taskExecutors.filter((t) => t.executorId !== executor!.executorId);
      }));
    } else {
      reuse = true;
      executor.updateProblemCollector(collector);
      executor.updateTerminalOptions(terminalOptions);
      executor.reset();
    }

    this.addDispose(executor.onDidTaskProcessExit((code) => {
      this._onDidStateChange.fire(TaskEvent.create(TaskEventKind.ProcessEnded, task, code));
      this._onDidStateChange.fire(TaskEvent.create(TaskEventKind.End, task));
    }));

    const result = executor.execute(task, reuse);

    const mapKey = task.getMapKey();
    this.activeTaskExecutors.set(mapKey, { promise: Promise.resolve(result), task, executor });

    await executor.processReady.promise;
    this._onDidStateChange.fire(TaskEvent.create(TaskEventKind.ProcessStarted, task, executor.processId));
    return {
      task,
      kind: TaskExecuteKind.Started,
      promise: Promise.resolve(result),
    };
  }

  private createTerminalName(task: CustomTask | ContributedTask): string {
    return formatLocalize('TerminalTaskSystem.terminalName', task.getQualifiedLabel() || task.configurationProperties.name);
  }

  private async resolveVariables(value: string[]): Promise<string> {
    const result: string[] = [];
    for (const item of value) {
      result.push(await this.resolveVariable(item));
    }
    return result.join(Path.separator);
  }

  private async resolveVariable(value: string | undefined): Promise<string>;
  private async resolveVariable(value: CommandString | undefined): Promise<CommandString>;
  private async resolveVariable(value: CommandString | undefined): Promise<CommandString> {
    // TODO@Dirk Task.getWorkspaceFolder should return a WorkspaceFolder that is defined in workspace.ts
    if (isString(value)) {
      return await this.variableResolver.resolve<string>(value);
    } else if (value !== undefined) {
      return {
        value: await this.variableResolver.resolve<string>(value.value),
        quoting: value.quoting,
      };
    } else { // This should never happen
      throw new Error('Should never try to resolve undefined.');
    }
  }

  private async resolveMatchers(values: Array<string | ProblemMatcher> | undefined): Promise<ProblemMatcher[]> {
    if (values === undefined || values === null || values.length === 0) {
      return [];
    }
    const result: ProblemMatcher[] = [];
    for (const value of values) {
      let matcher: ProblemMatcher | undefined;
      if (isString(value)) {
        if (value[0].startsWith('$')) {
          matcher = this.problemMatcher.get(value.substring(1));
        } else {
          matcher = this.problemMatcher.get(value);
        }
      } else {
        matcher = value;
      }
      if (!matcher) {
        continue;
      }
      const hasFilePrefix = matcher.filePrefix !== undefined;
      if (!hasFilePrefix) {
        result.push(matcher);
      } else {
        const copy = deepClone(matcher);
        if (hasFilePrefix) {
          copy.filePrefix = await this.resolveVariable(copy.filePrefix);
        }
        result.push(copy);
      }
    }
    return result;
  }

  getActiveTasks(): Task[] {
    return Array.from(this.activeTaskExecutors.values()).map((e) => e.task);
  }

  async terminate(task: Task): Promise<TaskTerminateResponse> {
    const key = task.getMapKey();
    const activeExecutor = this.activeTaskExecutors.get(key);
    if (!activeExecutor) {
      return Promise.resolve({ task: undefined, success: true });
    }
    const { success } = await activeExecutor.executor.terminate();
    this.activeTaskExecutors.delete(key);
    return { task, success };
  }

  rerun(): import('../common').ITaskExecuteResult | undefined {
    throw new Error('Method not implemented.');
  }
  isActive(): Promise<boolean> {
    throw new Error('Method not implemented.');
  }
  isActiveSync(): boolean {
    throw new Error('Method not implemented.');
  }

  getBusyTasks(): import('../common/task').Task[] {
    throw new Error('Method not implemented.');
  }
  canAutoTerminate(): boolean {
    throw new Error('Method not implemented.');
  }

  terminateAll(): Promise<import('../common').TaskTerminateResponse[]> {
    throw new Error('Method not implemented.');
  }
  revealTask(task: import('../common/task').Task): boolean {
    throw new Error('Method not implemented.');
  }
  customExecutionComplete(task: import('../common/task').Task, result: number): Promise<void> {
    throw new Error('Method not implemented.');
  }

}
