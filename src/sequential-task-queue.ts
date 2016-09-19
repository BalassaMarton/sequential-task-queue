export interface ITaskQueueOptions {
    name?: string;    
    errorHandler?: (e: any) => any;
    timeout?: number;
}

export interface ICancellationToken {
    cancelled?: boolean;
    reason?: string;
}

export var cancellationTokenReasons = {
    timeout: "timeout",
    cancel: "cancel"
}

export class TimeoutError extends Error {
}

export class SequentialTaskQueue {

    private _errorHandler: (e: any) => void;
    private _queue: ITaskEntry[] = [];
    private _isClosed: boolean = false;
    private _waiters: Function[] = [];
    private _timeout: number;
    private _currentTask: ITaskEntry;

    static defaultTimeout = 0;

    name: string;

    get isClosed() {
        return this._isClosed;
    }

    constructor(options?: ITaskQueueOptions) {
        if (!options)
            options = {};
        if (options.timeout === undefined || options.timeout === null)
            options.timeout = SequentialTaskQueue.defaultTimeout;
        this._timeout = options.timeout;
        this.name = options.name;
        this._errorHandler = options.errorHandler;
    }

    push(task: Function, timeout?: number): ICancellationToken {
        if (this._isClosed)
            throw new Error(`${this.name || "SequentialTaskQueue"} has been previously closed`);
        var entry: ITaskEntry = {
            fn: task,
            timeout: timeout === undefined ? this._timeout : timeout,
            cancellationToken: new CancellationToken()
        };
        this._queue.push(entry);
        this.schedule(() => this.next());
        return entry.cancellationToken;
    }

    cancel(): PromiseLike<any> {
        if (this._currentTask) {
            if (this._currentTask.timeoutHandle)
                clearTimeout(this._currentTask.timeoutHandle);
            this._currentTask.cancellationToken.cancel(cancellationTokenReasons.cancel);
        }
        this._queue.splice(0);
        return this.wait();
    }

    close(cancel?: boolean): PromiseLike<any> {
        if (this._isClosed)
            return this.wait();
        this._isClosed = true;
        if (cancel)
            return this.cancel();
        return this.wait();
    }

    wait(): PromiseLike<any> {
        if (!this._currentTask && this._queue.length === 0)
            return Promise.resolve();
        return new Promise(resolve => {
            this._waiters.push(resolve);
        });
    }

    onError(handler: (e: any) => void) {
        this._errorHandler = handler;
    }

    private next() {
        if (!this._currentTask) {
            let task = this._currentTask = this._queue.shift();
            if (task) {
                try {
                    if (task.cancellationToken.cancelled) {
                        this.schedule(() => this.next());
                        return;
                    }
                    if (task.timeout) {
                        task.timeoutHandle = setTimeout(() => {
                            task.timeoutHandle = undefined;
                            task.cancellationToken.cancel(cancellationTokenReasons.timeout);
                            this.handleError(new TimeoutError());
                            if (this._currentTask === task)
                                this.doneTask();
                        }, task.timeout);
                    }
                    let res = task.fn(task.cancellationToken);
                    if (res && isPromise(res)) {
                        res.then(() => {
                                if (this._currentTask === task)
                                    this.doneTask();
                            },
                            err => {
                                this.handleError(err);
                                if (this._currentTask === task)
                                    this.doneTask();
                            });
                    } else
                        this.doneTask();

                } catch (e) {
                    this.handleError(e);
                    this.doneTask();
                }
            } else {
                // queue is empty, call waiters
                this.callWaiters(); 
            }
        }
    }

    private doneTask() {
        if (this._currentTask.timeoutHandle)
            clearTimeout(this._currentTask.timeoutHandle);
        this._currentTask = undefined;
        if (!this._queue.length)
            this.callWaiters();
        else
            this.schedule(() => this.next());
    }

    private callWaiters() {
        let waiters = this._waiters.splice(0);
        waiters.forEach(waiter => waiter());
    }

    private schedule(fn: Function) {
        setTimeout(fn, 0);
    }

    private handleError(e: any) {
        try {
            if (typeof this._errorHandler === "function")
                this._errorHandler(e);
        } catch (ie) {
            // suppress errors thrown in error handler
        }
    }
}

class CancellationToken implements ICancellationToken {
    cancelled: boolean = false;
    reason: string = null;

    cancel(reason: string) {
        this.cancelled = true;
        this.reason = reason;
    }
}

interface ITaskEntry {
    fn: Function;
    timeout: number;
    timeoutHandle?: any;
    cancellationToken?: CancellationToken;
}

function isPromise(obj: any): obj is PromiseLike<any> {
    return (obj && typeof obj.then === "function");
}















