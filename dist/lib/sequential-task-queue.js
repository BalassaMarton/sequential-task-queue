"use strict";
/**
 * Standard cancellation reasons. {@link SequentialTaskQueue} sets {@link CancellationToken.reason}
 * to one of these values when cancelling a task for a reason other than the user code calling
 * {@link CancellationToken.cancel}.
 */
exports.cancellationTokenReasons = {
    /** Used when the task was cancelled in response to a call to {@link SequentialTaskQueue.cancel} */
    cancel: Object.create(null),
    /** Used when the task was cancelled after its timeout has passed */
    timeout: Object.create(null)
};
/**
 * Standard event names used by {@link SequentialTaskQueue}
 */
exports.sequentialTaskQueueEvents = {
    drained: "drained",
    error: "error",
    timeout: "timeout"
};
/**
 * FIFO task queue to run tasks in predictable order, without concurrency.
 */
class SequentialTaskQueue {
    /**
     * Creates a new instance of {@link SequentialTaskQueue}
     * @param options - Configuration options for the task queue.
    */
    constructor(options) {
        this.queue = [];
        this._isClosed = false;
        this.waiters = [];
        if (!options)
            options = {};
        this.defaultTimeout = options.timeout;
        this.name = options.name || "SequentialTaskQueue";
        this.scheduler = options.scheduler || SequentialTaskQueue.defaultScheduler;
    }
    /** Indicates if the queue has been closed. Calling {@link SequentialTaskQueue.push} on a closed queue will result in an exception. */
    get isClosed() {
        return this._isClosed;
    }
    /**
     * Adds a new task to the queue.
     * @param task - The function to call when the task is run
     * @param timeout - An optional timeout (in milliseconds) for the task, after which it should be cancelled to avoid hanging tasks clogging up the queue.
     * @returns A {@link CancellationToken} that may be used to cancel the task before it completes.
     */
    push(task, options) {
        if (this._isClosed)
            throw new Error(`${this.name} has been previously closed`);
        var taskEntry = {
            callback: task,
            args: options && options.args ? (Array.isArray(options.args) ? options.args.slice() : [options.args]) : [],
            timeout: options && options.timeout !== undefined ? options.timeout : this.defaultTimeout,
            cancellationToken: {
                cancel: (reason) => this.cancelTask(taskEntry, reason)
            },
            resolve: undefined,
            reject: undefined
        };
        taskEntry.args.push(taskEntry.cancellationToken);
        this.queue.push(taskEntry);
        this.scheduler.schedule(() => this.next());
        var result = new Promise((resolve, reject) => {
            taskEntry.resolve = resolve;
            taskEntry.reject = reject;
        });
        result.cancel = (reason) => taskEntry.cancellationToken.cancel(reason);
        return result;
    }
    /**
     * Cancels the currently running task (if any), and clears the queue.
     * @returns {Promise} A Promise that is fulfilled when the queue is empty and the current task has been cancelled.
     */
    cancel() {
        if (this.currentTask)
            this.cancelTask(this.currentTask, exports.cancellationTokenReasons.cancel);
        var queue = this.queue.splice(0);
        // Cancel all and emit a drained event if there were tasks waiting in the queue
        if (queue.length) {
            queue.forEach(task => this.cancelTask(task, exports.cancellationTokenReasons.cancel));
            this.emit(exports.sequentialTaskQueueEvents.drained);
        }
        return this.wait();
    }
    /**
     * Closes the queue, preventing new tasks to be added.
     * Any calls to {@link SequentialTaskQueue.push} after closing the queue will result in an exception.
     * @param {boolean} cancel - Indicates that the queue should also be cancelled.
     * @returns {Promise} A Promise that is fulfilled when the queue has finished executing remaining tasks.
     */
    close(cancel) {
        if (!this._isClosed) {
            this._isClosed = true;
            if (cancel)
                return this.cancel();
        }
        return this.wait();
    }
    /**
     * Returns a promise that is fulfilled when the queue is empty.
     * @returns {Promise}
     */
    wait() {
        if (!this.currentTask && this.queue.length === 0)
            return Promise.resolve();
        return new Promise(resolve => {
            this.waiters.push(resolve);
        });
    }
    /**
     * Adds an event handler for a named event.
     * @param {string} evt - Event name. See the readme for a list of valid events.
     * @param {Function} handler - Event handler. When invoking the handler, the queue will set itself as the `this` argument of the call.
     */
    on(evt, handler) {
        this.events = this.events || {};
        (this.events[evt] || (this.events[evt] = [])).push(handler);
    }
    /**
     * Adds a single-shot event handler for a named event.
     * @param {string} evt - Event name. See the readme for a list of valid events.
     * @param {Function} handler - Event handler. When invoking the handler, the queue will set itself as the `this` argument of the call.
     */
    once(evt, handler) {
        var cb = (...args) => {
            this.removeListener(evt, cb);
            handler.apply(this, args);
        };
        this.on(evt, cb);
    }
    /**
     * Removes an event handler.
     * @param {string} evt - Event name
     * @param {Function} handler - Event handler to be removed
     */
    removeListener(evt, handler) {
        if (this.events) {
            var list = this.events[evt];
            if (list) {
                var i = 0;
                while (i < list.length) {
                    if (list[i] === handler)
                        list.splice(i, 1);
                    else
                        i++;
                }
            }
        }
    }
    /** @see {@link SequentialTaskQueue.removeListener} */
    off(evt, handler) {
        return this.removeListener(evt, handler);
    }
    emit(evt, ...args) {
        if (this.events && this.events[evt])
            try {
                this.events[evt].forEach(fn => fn.apply(this, args));
            }
            catch (e) {
                console.error(`${this.name}: Exception in '${evt}' event handler`, e);
            }
    }
    next() {
        // Try running the next task, if not currently running one 
        if (!this.currentTask) {
            var task = this.queue.shift();
            // skip cancelled tasks
            while (task && task.cancellationToken.cancelled)
                task = this.queue.shift();
            if (task) {
                try {
                    this.currentTask = task;
                    if (task.timeout) {
                        task.timeoutHandle = setTimeout(() => {
                            this.emit(exports.sequentialTaskQueueEvents.timeout);
                            this.cancelTask(task, exports.cancellationTokenReasons.timeout);
                        }, task.timeout);
                    }
                    let res = task.callback.apply(undefined, task.args);
                    if (res && isPromise(res)) {
                        res.then(result => {
                            task.result = result;
                            this.doneTask(task);
                        }, err => {
                            this.doneTask(task, err);
                        });
                    }
                    else {
                        task.result = res;
                        this.doneTask(task);
                    }
                }
                catch (e) {
                    this.doneTask(task, e);
                }
            }
            else {
                // queue is empty, call waiters
                this.callWaiters();
            }
        }
    }
    cancelTask(task, reason) {
        task.cancellationToken.cancelled = true;
        task.cancellationToken.reason = reason;
        this.doneTask(task);
    }
    doneTask(task, error) {
        if (task.timeoutHandle)
            clearTimeout(task.timeoutHandle);
        task.cancellationToken.cancel = noop;
        if (error) {
            this.emit(exports.sequentialTaskQueueEvents.error, error);
            task.reject.call(undefined, error);
        }
        else if (task.cancellationToken.cancelled)
            task.reject.call(undefined, task.cancellationToken.reason);
        else
            task.resolve.call(undefined, task.result);
        if (this.currentTask === task) {
            this.currentTask = undefined;
            if (!this.queue.length) {
                this.emit(exports.sequentialTaskQueueEvents.drained);
                this.callWaiters();
            }
            else
                this.scheduler.schedule(() => this.next());
        }
    }
    callWaiters() {
        let waiters = this.waiters.splice(0);
        waiters.forEach(waiter => waiter());
    }
}
SequentialTaskQueue.defaultScheduler = {
    schedule: callback => setTimeout(callback, 0)
};
exports.SequentialTaskQueue = SequentialTaskQueue;
function noop() {
}
function isPromise(obj) {
    return (obj && typeof obj.then === "function");
}
SequentialTaskQueue.defaultScheduler = {
    schedule: typeof setImmediate === "function"
        ? callback => setImmediate(callback)
        : callback => setTimeout(callback, 0)
};
