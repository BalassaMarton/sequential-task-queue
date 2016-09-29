"use strict";
/**
 * Standard cancellation reasons. {@link SequentialTaskQueue} sets {@link CancellationToken#reason}
 * to one of these values when cancelling a task for a reason other than the user code calling
 * {@link CancellationToken#cancel}.
 */
exports.cancellationTokenReasons = {
    /** Used when the task was cancelled in response to a call to {@link SequentialTaskQueue#cancel} */
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
     * @param {TaskQueueOptions} options - Configuration options for the task queue.
    */
    constructor(options) {
        this.queue = [];
        this._isClosed = false;
        this.waiters = [];
        if (!options)
            options = {};
        this.defaultTimeout = options.timeout;
        this.name = options.name || "SequentialTaskQueue";
        this.scheduler = options.scheduler || {
            schedule: cb => setTimeout(cb, 0)
        };
    }
    /** Indicates if the queue has been closed. Calling {@link SequentialTaskQueue#push} on a closed queue will result in an exception. */
    get isClosed() {
        return this._isClosed;
    }
    /**
     * Adds a new task to the queue.
     * @param {Function} task - The function to call when the task is run
     * @param {number} timeout - An optional timeout (in milliseconds) for the task, after which it should be cancelled to avoid hanging tasks clogging up the queue.
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
            }
        };
        taskEntry.args.push(taskEntry.cancellationToken);
        this.queue.push(taskEntry);
        this.scheduler.schedule(() => this.next());
        return taskEntry.cancellationToken;
    }
    /**
     * Cancels the currently running task (if any), and clears the queue.
     * @returns {Promise} A Promise that is fulfilled when the queue is empty and the current task has been cancelled.
     */
    cancel() {
        if (this.currentTask)
            this.cancelTask(this.currentTask, exports.cancellationTokenReasons.cancel);
        // emit a drained event if there were tasks waiting in the queue
        if (this.queue.splice(0).length)
            this.emit(exports.sequentialTaskQueueEvents.drained);
        return this.wait();
    }
    /**
     * Closes the queue, preventing new tasks to be added.
     * Any calls to {@link SequentialTaskQueue#push} after closing the queue will result in an exception.
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
            this.off(evt, cb);
            handler.apply(this, args);
        };
        this.on(evt, cb);
    }
    /**
     * Removes an event handler.
     * @param {string} evt - Event name
     * @param {Function} handler - Event handler to be removed
     */
    off(evt, handler) {
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
                        res.then(() => {
                            this.doneTask(task);
                        }, err => {
                            this.doneTask(task, err);
                        });
                    }
                    else
                        this.doneTask(task);
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
        if (error)
            this.emit(exports.sequentialTaskQueueEvents.error, error);
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
exports.SequentialTaskQueue = SequentialTaskQueue;
function noop() {
}
function isPromise(obj) {
    return (obj && typeof obj.then === "function");
}

//# sourceMappingURL=data:application/json;base64,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Q0FBQyxJQUFJLENBQUMsaUNBQXlCLENBQUMsS0FBSyxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQ3RELEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxXQUFXLEtBQUssSUFBSSxDQUFDLENBQUMsQ0FBQztZQUM1QixJQUFJLENBQUMsV0FBVyxHQUFHLFNBQVMsQ0FBQztZQUM3QixFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQztnQkFDckIsSUFBSSxDQUFDLElBQUksQ0FBQyxpQ0FBeUIsQ0FBQyxPQUFPLENBQUMsQ0FBQztnQkFDN0MsSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDO1lBQ3ZCLENBQUM7WUFDRCxJQUFJO2dCQUNBLElBQUksQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLE1BQU0sSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDLENBQUM7UUFDbkQsQ0FBQztJQUNMLENBQUM7SUFFTyxXQUFXO1FBQ2YsSUFBSSxPQUFPLEdBQUcsSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDckMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxNQUFNLElBQUksTUFBTSxFQUFFLENBQUMsQ0FBQztJQUN4QyxDQUFDO0FBQ0wsQ0FBQztBQXBOWSwyQkFBbUIsc0JBb04vQixDQUFBO0FBVUQ7QUFDQSxDQUFDO0FBRUQsbUJBQW1CLEdBQVE7SUFDdkIsTUFBTSxDQUFDLENBQUMsR0FBRyxJQUFJLE9BQU8sR0FBRyxDQUFDLElBQUksS0FBSyxVQUFVLENBQUMsQ0FBQztBQUNuRCxDQUFDIiwiZmlsZSI6InNlcXVlbnRpYWwtdGFzay1xdWV1ZS5qcyIsInNvdXJjZXNDb250ZW50IjpbIi8qKiBcclxuICogUmVwcmVzZW50cyBhbiBvYmplY3QgdGhhdCBzY2hlZHVsZXMgYSBmdW5jdGlvbiBmb3IgYXN5bmNocm9ub3VzIGV4ZWN1dGlvbi5cclxuICogVGhlIGRlZmF1bHQgaW1wbGVtZW50YXRpb24gdXNlZCBieSB7QGxpbmsgU2VxdWVudGlhbFRhc2tRdWV1ZX0gY2FsbHMge0BsaW5rIHNldFRpbWVvdXR9XHJcbiAqIEBwYXJhbSB7IEZ1bmN0aW9uIH0gY2FsbGJhY2s6IFRoZSBmdW5jdGlvbiB0aGF0IG5lZWRzIHRvIGJlIHNjaGVkdWxlZC4gXHJcbiAqIFxyXG4gICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgU2NoZWR1bGVyIHtcclxuICAgIHNjaGVkdWxlKGNhbGxiYWNrOiBGdW5jdGlvbik6IHZvaWQ7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBPYmplY3QgdXNlZCBmb3IgcGFzc2luZyBjb25maWd1cmF0aW9uIG9wdGlvbnMgdG8gdGhlIHtAbGluayBTZXF1ZW50aWFsVGFza1F1ZXVlfSBjb25zdHJ1Y3Rvci5cclxuICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgVGFza1F1ZXVlT3B0aW9ucyB7XHJcbiAgICAvKipcclxuICAgICAqIEFzc2lnbnMgYSBuYW1lIHRvIHRoZSB0YXNrIHF1ZXVlIGZvciBkaWFnbm9zdGljIHB1cnBvc2VzLiBUaGUgbmFtZSBkb2VzIG5vdCBuZWVkIHRvIGJlIHVuaXF1ZS5cclxuICAgICAqL1xyXG4gICAgbmFtZT86IHN0cmluZztcclxuICAgIC8qKlxyXG4gICAgICogRGVmYXVsdCB0aW1lb3V0IChpbiBtaWxsaXNlY29uZHMpIGZvciB0YXNrcyBwdXNoZWQgdG8gdGhlIHF1ZXVlLiBEZWZhdWx0IGlzIDAgKG5vIHRpbWVvdXQpLlxyXG4gICAgICogICovICAgIFxyXG4gICAgdGltZW91dD86IG51bWJlcjtcclxuICAgIC8qKlxyXG4gICAgICogU2NoZWR1bGVyIHVzZWQgYnkgdGhlIHF1ZXVlLiBcclxuICAgICAqL1xyXG4gICAgc2NoZWR1bGVyPzogU2NoZWR1bGVyO1xyXG59XHJcblxyXG4vKipcclxuICogT3B0aW9ucyBvYmplY3QgZm9yIGluZGl2aWR1YWwgdGFza3MuXHJcbiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIFRhc2tPcHRpb25zIHtcclxuICAgIC8qKlxyXG4gICAgICogVGltZW91dCBmb3IgdGhlIHRhc2ssIGluIG1pbGxpc2Vjb25kcy4gXHJcbiAgICAgKiAqL1xyXG4gICAgdGltZW91dD86IG51bWJlcjtcclxuXHJcbiAgICAvKipcclxuICAgICAqIEFyZ3VtZW50cyB0byBwYXNzIHRvIHRoZSB0YXNrLiBVc2VmdWwgZm9yIG1pbmltYWxpc2luZyB0aGUgbnVtYmVyIG9mIEZ1bmN0aW9uIG9iamVjdHMgYW5kIGNsb3N1cmVzIGNyZWF0ZWQgXHJcbiAgICAgKiB3aGVuIHB1c2hpbmcgdGhlIHNhbWUgdGFzayBtdWx0aXBsZSB0aW1lcywgd2l0aCBkaWZmZXJlbnQgYXJndW1lbnRzLiAgXHJcbiAgICAgKiBcclxuICAgICAqIEBleGFtcGxlXHJcbiAgICAgKiAvLyBUaGUgZm9sbG93aW5nIGNvZGUgY3JlYXRlcyBhIHNpbmdsZSBGdW5jdGlvbiBvYmplY3QgYW5kIG5vIGNsb3N1cmVzOlxyXG4gICAgICogZm9yIChsZXQgaSA9IDA7IGkgPCAxMDA7IGkrKylcclxuICAgICAqICAgICBxdWV1ZS5wdXNoKHByb2Nlc3MsIHthcmdzOiBbaV19KTtcclxuICAgICAqIGZ1bmN0aW9uIHByb2Nlc3Mobikge1xyXG4gICAgICogICAgIGNvbnNvbGUubG9nKG4pO1xyXG4gICAgICogfVxyXG4gICAgICovXHJcbiAgICBhcmdzPzogYW55OyAgICBcclxufVxyXG5cclxuLyoqXHJcbiAqIFByb3ZpZGVzIHRoZSBBUEkgZm9yIHF1ZXJ5aW5nIGFuZCBpbnZva2luZyB0YXNrIGNhbmNlbGxhdGlvbi5cclxuICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgQ2FuY2VsbGF0aW9uVG9rZW4ge1xyXG4gICAgLyoqXHJcbiAgICAgKiBXaGVuIGB0cnVlYCwgaW5kaWNhdGVzIHRoYXQgdGhlIHRhc2sgaGFzIGJlZW4gY2FuY2VsbGVkLiBcclxuICAgICAqL1xyXG4gICAgY2FuY2VsbGVkPzogYm9vbGVhbjtcclxuICAgIC8qKlxyXG4gICAgICogQW4gYXJiaXRyYXJ5IG9iamVjdCByZXByZXNlbnRpbmcgdGhlIHJlYXNvbiBvZiB0aGUgY2FuY2VsbGF0aW9uLiBDYW4gYmUgYSBtZW1iZXIgb2YgdGhlIHtAbGluayBjYW5jZWxsYXRpb25Ub2tlblJlYXNvbnN9IG9iamVjdCBvciBhbiBgRXJyb3JgLCBldGMuICBcclxuICAgICAqL1xyXG4gICAgcmVhc29uPzogYW55O1xyXG4gICAgLyoqXHJcbiAgICAgKiBDYW5jZWxzIHRoZSB0YXNrIGZvciB3aGljaCB0aGUgY2FuY2VsbGF0aW9uIHRva2VuIHdhcyBjcmVhdGVkLlxyXG4gICAgICogQHBhcmFtIHJlYXNvbiAtIFRoZSByZWFzb24gb2YgdGhlIGNhbmNlbGxhdGlvbiwgc2VlIHtAbGluayBDYW5jZWxsYXRpb25Ub2tlbiNyZWFzb259IFxyXG4gICAgICovXHJcbiAgICBjYW5jZWwocmVhc29uPzogYW55KTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFN0YW5kYXJkIGNhbmNlbGxhdGlvbiByZWFzb25zLiB7QGxpbmsgU2VxdWVudGlhbFRhc2tRdWV1ZX0gc2V0cyB7QGxpbmsgQ2FuY2VsbGF0aW9uVG9rZW4jcmVhc29ufSBcclxuICogdG8gb25lIG9mIHRoZXNlIHZhbHVlcyB3aGVuIGNhbmNlbGxpbmcgYSB0YXNrIGZvciBhIHJlYXNvbiBvdGhlciB0aGFuIHRoZSB1c2VyIGNvZGUgY2FsbGluZ1xyXG4gKiB7QGxpbmsgQ2FuY2VsbGF0aW9uVG9rZW4jY2FuY2VsfS4gICAgXHJcbiAqL1xyXG5leHBvcnQgdmFyIGNhbmNlbGxhdGlvblRva2VuUmVhc29ucyA9IHtcclxuICAgIC8qKiBVc2VkIHdoZW4gdGhlIHRhc2sgd2FzIGNhbmNlbGxlZCBpbiByZXNwb25zZSB0byBhIGNhbGwgdG8ge0BsaW5rIFNlcXVlbnRpYWxUYXNrUXVldWUjY2FuY2VsfSAqL1xyXG4gICAgY2FuY2VsOiBPYmplY3QuY3JlYXRlKG51bGwpLFxyXG4gICAgLyoqIFVzZWQgd2hlbiB0aGUgdGFzayB3YXMgY2FuY2VsbGVkIGFmdGVyIGl0cyB0aW1lb3V0IGhhcyBwYXNzZWQgKi9cclxuICAgIHRpbWVvdXQ6IE9iamVjdC5jcmVhdGUobnVsbClcclxufVxyXG5cclxuLyoqXHJcbiAqIFN0YW5kYXJkIGV2ZW50IG5hbWVzIHVzZWQgYnkge0BsaW5rIFNlcXVlbnRpYWxUYXNrUXVldWV9XHJcbiAqL1xyXG5leHBvcnQgdmFyIHNlcXVlbnRpYWxUYXNrUXVldWVFdmVudHMgPSB7XHJcbiAgICBkcmFpbmVkOiBcImRyYWluZWRcIixcclxuICAgIGVycm9yOiBcImVycm9yXCIsXHJcbiAgICB0aW1lb3V0OiBcInRpbWVvdXRcIlxyXG59XHJcblxyXG4vKipcclxuICogRklGTyB0YXNrIHF1ZXVlIHRvIHJ1biB0YXNrcyBpbiBwcmVkaWN0YWJsZSBvcmRlciwgd2l0aG91dCBjb25jdXJyZW5jeS5cclxuICovXHJcbmV4cG9ydCBjbGFzcyBTZXF1ZW50aWFsVGFza1F1ZXVlIHtcclxuXHJcbiAgICBwcml2YXRlIHF1ZXVlOiBUYXNrRW50cnlbXSA9IFtdO1xyXG4gICAgcHJpdmF0ZSBfaXNDbG9zZWQ6IGJvb2xlYW4gPSBmYWxzZTtcclxuICAgIHByaXZhdGUgd2FpdGVyczogRnVuY3Rpb25bXSA9IFtdO1xyXG4gICAgcHJpdmF0ZSBkZWZhdWx0VGltZW91dDogbnVtYmVyO1xyXG4gICAgcHJpdmF0ZSBjdXJyZW50VGFzazogVGFza0VudHJ5O1xyXG4gICAgcHJpdmF0ZSBzY2hlZHVsZXI6IFNjaGVkdWxlcjtcclxuICAgIHByaXZhdGUgZXZlbnRzOiB7IFtrZXk6IHN0cmluZ106IEZ1bmN0aW9uW10gfTtcclxuXHJcbiAgICBuYW1lOiBzdHJpbmc7XHJcblxyXG4gICAgLyoqIEluZGljYXRlcyBpZiB0aGUgcXVldWUgaGFzIGJlZW4gY2xvc2VkLiBDYWxsaW5nIHtAbGluayBTZXF1ZW50aWFsVGFza1F1ZXVlI3B1c2h9IG9uIGEgY2xvc2VkIHF1ZXVlIHdpbGwgcmVzdWx0IGluIGFuIGV4Y2VwdGlvbi4gKi9cclxuICAgIGdldCBpc0Nsb3NlZCgpIHtcclxuICAgICAgICByZXR1cm4gdGhpcy5faXNDbG9zZWQ7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqIFxyXG4gICAgICogQ3JlYXRlcyBhIG5ldyBpbnN0YW5jZSBvZiB7QGxpbmsgU2VxdWVudGlhbFRhc2tRdWV1ZX1cclxuICAgICAqIEBwYXJhbSB7VGFza1F1ZXVlT3B0aW9uc30gb3B0aW9ucyAtIENvbmZpZ3VyYXRpb24gb3B0aW9ucyBmb3IgdGhlIHRhc2sgcXVldWUuXHJcbiAgICAqL1xyXG4gICAgY29uc3RydWN0b3Iob3B0aW9ucz86IFRhc2tRdWV1ZU9wdGlvbnMpIHtcclxuICAgICAgICBpZiAoIW9wdGlvbnMpXHJcbiAgICAgICAgICAgIG9wdGlvbnMgPSB7fTtcclxuICAgICAgICB0aGlzLmRlZmF1bHRUaW1lb3V0ID0gb3B0aW9ucy50aW1lb3V0O1xyXG4gICAgICAgIHRoaXMubmFtZSA9IG9wdGlvbnMubmFtZSB8fCBcIlNlcXVlbnRpYWxUYXNrUXVldWVcIjtcclxuICAgICAgICB0aGlzLnNjaGVkdWxlciA9IG9wdGlvbnMuc2NoZWR1bGVyIHx8IHtcclxuICAgICAgICAgICAgc2NoZWR1bGU6IGNiID0+IHNldFRpbWVvdXQoPHR5cGVvZiBzZXRUaW1lb3V0PmNiLCAwKVxyXG4gICAgICAgIH07XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBBZGRzIGEgbmV3IHRhc2sgdG8gdGhlIHF1ZXVlLlxyXG4gICAgICogQHBhcmFtIHtGdW5jdGlvbn0gdGFzayAtIFRoZSBmdW5jdGlvbiB0byBjYWxsIHdoZW4gdGhlIHRhc2sgaXMgcnVuXHJcbiAgICAgKiBAcGFyYW0ge251bWJlcn0gdGltZW91dCAtIEFuIG9wdGlvbmFsIHRpbWVvdXQgKGluIG1pbGxpc2Vjb25kcykgZm9yIHRoZSB0YXNrLCBhZnRlciB3aGljaCBpdCBzaG91bGQgYmUgY2FuY2VsbGVkIHRvIGF2b2lkIGhhbmdpbmcgdGFza3MgY2xvZ2dpbmcgdXAgdGhlIHF1ZXVlLiBcclxuICAgICAqIEByZXR1cm5zIEEge0BsaW5rIENhbmNlbGxhdGlvblRva2VufSB0aGF0IG1heSBiZSB1c2VkIHRvIGNhbmNlbCB0aGUgdGFzayBiZWZvcmUgaXQgY29tcGxldGVzLlxyXG4gICAgICovXHJcbiAgICBwdXNoKHRhc2s6IEZ1bmN0aW9uLCBvcHRpb25zPzogVGFza09wdGlvbnMpOiBDYW5jZWxsYXRpb25Ub2tlbiB7XHJcbiAgICAgICAgaWYgKHRoaXMuX2lzQ2xvc2VkKVxyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYCR7dGhpcy5uYW1lfSBoYXMgYmVlbiBwcmV2aW91c2x5IGNsb3NlZGApO1xyXG4gICAgICAgIHZhciB0YXNrRW50cnk6IFRhc2tFbnRyeSA9IHtcclxuICAgICAgICAgICAgY2FsbGJhY2s6IHRhc2ssXHJcbiAgICAgICAgICAgIGFyZ3M6IG9wdGlvbnMgJiYgb3B0aW9ucy5hcmdzID8gKEFycmF5LmlzQXJyYXkob3B0aW9ucy5hcmdzKSA/IG9wdGlvbnMuYXJncy5zbGljZSgpIDogW29wdGlvbnMuYXJnc10pIDogW10sXHJcbiAgICAgICAgICAgIHRpbWVvdXQ6IG9wdGlvbnMgJiYgb3B0aW9ucy50aW1lb3V0ICE9PSB1bmRlZmluZWQgPyBvcHRpb25zLnRpbWVvdXQgOiB0aGlzLmRlZmF1bHRUaW1lb3V0LFxyXG4gICAgICAgICAgICBjYW5jZWxsYXRpb25Ub2tlbjoge1xyXG4gICAgICAgICAgICAgICAgY2FuY2VsOiAocmVhc29uPykgPT4gdGhpcy5jYW5jZWxUYXNrKHRhc2tFbnRyeSwgcmVhc29uKVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfTtcclxuICAgICAgICB0YXNrRW50cnkuYXJncy5wdXNoKHRhc2tFbnRyeS5jYW5jZWxsYXRpb25Ub2tlbik7XHJcbiAgICAgICAgdGhpcy5xdWV1ZS5wdXNoKHRhc2tFbnRyeSk7XHJcbiAgICAgICAgdGhpcy5zY2hlZHVsZXIuc2NoZWR1bGUoKCkgPT4gdGhpcy5uZXh0KCkpO1xyXG4gICAgICAgIHJldHVybiB0YXNrRW50cnkuY2FuY2VsbGF0aW9uVG9rZW47XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBDYW5jZWxzIHRoZSBjdXJyZW50bHkgcnVubmluZyB0YXNrIChpZiBhbnkpLCBhbmQgY2xlYXJzIHRoZSBxdWV1ZS5cclxuICAgICAqIEByZXR1cm5zIHtQcm9taXNlfSBBIFByb21pc2UgdGhhdCBpcyBmdWxmaWxsZWQgd2hlbiB0aGUgcXVldWUgaXMgZW1wdHkgYW5kIHRoZSBjdXJyZW50IHRhc2sgaGFzIGJlZW4gY2FuY2VsbGVkLlxyXG4gICAgICovXHJcbiAgICBjYW5jZWwoKTogUHJvbWlzZUxpa2U8YW55PiB7XHJcbiAgICAgICAgaWYgKHRoaXMuY3VycmVudFRhc2spIFxyXG4gICAgICAgICAgICB0aGlzLmNhbmNlbFRhc2sodGhpcy5jdXJyZW50VGFzaywgY2FuY2VsbGF0aW9uVG9rZW5SZWFzb25zLmNhbmNlbCk7XHJcbiAgICAgICAgLy8gZW1pdCBhIGRyYWluZWQgZXZlbnQgaWYgdGhlcmUgd2VyZSB0YXNrcyB3YWl0aW5nIGluIHRoZSBxdWV1ZVxyXG4gICAgICAgIGlmICh0aGlzLnF1ZXVlLnNwbGljZSgwKS5sZW5ndGgpXHJcbiAgICAgICAgICAgIHRoaXMuZW1pdChzZXF1ZW50aWFsVGFza1F1ZXVlRXZlbnRzLmRyYWluZWQpO1xyXG4gICAgICAgIHJldHVybiB0aGlzLndhaXQoKTtcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIENsb3NlcyB0aGUgcXVldWUsIHByZXZlbnRpbmcgbmV3IHRhc2tzIHRvIGJlIGFkZGVkLiBcclxuICAgICAqIEFueSBjYWxscyB0byB7QGxpbmsgU2VxdWVudGlhbFRhc2tRdWV1ZSNwdXNofSBhZnRlciBjbG9zaW5nIHRoZSBxdWV1ZSB3aWxsIHJlc3VsdCBpbiBhbiBleGNlcHRpb24uXHJcbiAgICAgKiBAcGFyYW0ge2Jvb2xlYW59IGNhbmNlbCAtIEluZGljYXRlcyB0aGF0IHRoZSBxdWV1ZSBzaG91bGQgYWxzbyBiZSBjYW5jZWxsZWQuXHJcbiAgICAgKiBAcmV0dXJucyB7UHJvbWlzZX0gQSBQcm9taXNlIHRoYXQgaXMgZnVsZmlsbGVkIHdoZW4gdGhlIHF1ZXVlIGhhcyBmaW5pc2hlZCBleGVjdXRpbmcgcmVtYWluaW5nIHRhc2tzLiAgXHJcbiAgICAgKi9cclxuICAgIGNsb3NlKGNhbmNlbD86IGJvb2xlYW4pOiBQcm9taXNlTGlrZTxhbnk+IHtcclxuICAgICAgICBpZiAoIXRoaXMuX2lzQ2xvc2VkKSB7XHJcbiAgICAgICAgICAgIHRoaXMuX2lzQ2xvc2VkID0gdHJ1ZTtcclxuICAgICAgICAgICAgaWYgKGNhbmNlbClcclxuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLmNhbmNlbCgpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gdGhpcy53YWl0KCk7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBSZXR1cm5zIGEgcHJvbWlzZSB0aGF0IGlzIGZ1bGZpbGxlZCB3aGVuIHRoZSBxdWV1ZSBpcyBlbXB0eS5cclxuICAgICAqIEByZXR1cm5zIHtQcm9taXNlfVxyXG4gICAgICovXHJcbiAgICB3YWl0KCk6IFByb21pc2VMaWtlPGFueT4ge1xyXG4gICAgICAgIGlmICghdGhpcy5jdXJyZW50VGFzayAmJiB0aGlzLnF1ZXVlLmxlbmd0aCA9PT0gMClcclxuICAgICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xyXG4gICAgICAgIHJldHVybiBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcclxuICAgICAgICAgICAgdGhpcy53YWl0ZXJzLnB1c2gocmVzb2x2ZSk7XHJcbiAgICAgICAgfSk7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBBZGRzIGFuIGV2ZW50IGhhbmRsZXIgZm9yIGEgbmFtZWQgZXZlbnQuXHJcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gZXZ0IC0gRXZlbnQgbmFtZS4gU2VlIHRoZSByZWFkbWUgZm9yIGEgbGlzdCBvZiB2YWxpZCBldmVudHMuXHJcbiAgICAgKiBAcGFyYW0ge0Z1bmN0aW9ufSBoYW5kbGVyIC0gRXZlbnQgaGFuZGxlci4gV2hlbiBpbnZva2luZyB0aGUgaGFuZGxlciwgdGhlIHF1ZXVlIHdpbGwgc2V0IGl0c2VsZiBhcyB0aGUgYHRoaXNgIGFyZ3VtZW50IG9mIHRoZSBjYWxsLiBcclxuICAgICAqL1xyXG4gICAgb24oZXZ0OiBzdHJpbmcsIGhhbmRsZXI6IEZ1bmN0aW9uKSB7XHJcbiAgICAgICAgdGhpcy5ldmVudHMgPSB0aGlzLmV2ZW50cyB8fCB7fTtcclxuICAgICAgICAodGhpcy5ldmVudHNbZXZ0XSB8fCAodGhpcy5ldmVudHNbZXZ0XSA9IFtdKSkucHVzaChoYW5kbGVyKTsgICAgIFxyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICogQWRkcyBhIHNpbmdsZS1zaG90IGV2ZW50IGhhbmRsZXIgZm9yIGEgbmFtZWQgZXZlbnQuXHJcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gZXZ0IC0gRXZlbnQgbmFtZS4gU2VlIHRoZSByZWFkbWUgZm9yIGEgbGlzdCBvZiB2YWxpZCBldmVudHMuXHJcbiAgICAgKiBAcGFyYW0ge0Z1bmN0aW9ufSBoYW5kbGVyIC0gRXZlbnQgaGFuZGxlci4gV2hlbiBpbnZva2luZyB0aGUgaGFuZGxlciwgdGhlIHF1ZXVlIHdpbGwgc2V0IGl0c2VsZiBhcyB0aGUgYHRoaXNgIGFyZ3VtZW50IG9mIHRoZSBjYWxsLiBcclxuICAgICAqL1xyXG4gICAgb25jZShldnQ6IHN0cmluZywgaGFuZGxlcjogRnVuY3Rpb24pIHtcclxuICAgICAgICB2YXIgY2IgPSAoLi4uYXJnczogYW55W10pID0+IHtcclxuICAgICAgICAgICAgdGhpcy5vZmYoZXZ0LCBjYik7XHJcbiAgICAgICAgICAgIGhhbmRsZXIuYXBwbHkodGhpcywgYXJncyk7XHJcbiAgICAgICAgfTtcclxuICAgICAgICB0aGlzLm9uKGV2dCwgY2IpO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICogUmVtb3ZlcyBhbiBldmVudCBoYW5kbGVyLlxyXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IGV2dCAtIEV2ZW50IG5hbWVcclxuICAgICAqIEBwYXJhbSB7RnVuY3Rpb259IGhhbmRsZXIgLSBFdmVudCBoYW5kbGVyIHRvIGJlIHJlbW92ZWRcclxuICAgICAqL1xyXG4gICAgb2ZmKGV2dDogc3RyaW5nLCBoYW5kbGVyOiBGdW5jdGlvbikge1xyXG4gICAgICAgIGlmICh0aGlzLmV2ZW50cykge1xyXG4gICAgICAgICAgICB2YXIgbGlzdCA9IHRoaXMuZXZlbnRzW2V2dF07XHJcbiAgICAgICAgICAgIGlmIChsaXN0KSB7XHJcbiAgICAgICAgICAgICAgICB2YXIgaSA9IDA7XHJcbiAgICAgICAgICAgICAgICB3aGlsZSAoaSA8IGxpc3QubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKGxpc3RbaV0gPT09IGhhbmRsZXIpXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGxpc3Quc3BsaWNlKGksIDEpO1xyXG4gICAgICAgICAgICAgICAgICAgIGVsc2VcclxuICAgICAgICAgICAgICAgICAgICAgICAgaSsrO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgZW1pdChldnQ6IHN0cmluZywgLi4uYXJnczogYW55W10pIHtcclxuICAgICAgICBpZiAodGhpcy5ldmVudHMgJiYgdGhpcy5ldmVudHNbZXZ0XSlcclxuICAgICAgICAgICAgdHJ5IHsgXHJcbiAgICAgICAgICAgICAgICB0aGlzLmV2ZW50c1tldnRdLmZvckVhY2goZm4gPT4gZm4uYXBwbHkodGhpcywgYXJncykpO1xyXG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmVycm9yKGAke3RoaXMubmFtZX06IEV4Y2VwdGlvbiBpbiAnJHtldnR9JyBldmVudCBoYW5kbGVyYCwgZSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIG5leHQoKSB7XHJcbiAgICAgICAgLy8gVHJ5IHJ1bm5pbmcgdGhlIG5leHQgdGFzaywgaWYgbm90IGN1cnJlbnRseSBydW5uaW5nIG9uZSBcclxuICAgICAgICBpZiAoIXRoaXMuY3VycmVudFRhc2spIHtcclxuICAgICAgICAgICAgdmFyIHRhc2sgPSB0aGlzLnF1ZXVlLnNoaWZ0KCk7XHJcbiAgICAgICAgICAgIC8vIHNraXAgY2FuY2VsbGVkIHRhc2tzXHJcbiAgICAgICAgICAgIHdoaWxlICh0YXNrICYmIHRhc2suY2FuY2VsbGF0aW9uVG9rZW4uY2FuY2VsbGVkKVxyXG4gICAgICAgICAgICAgICAgdGFzayA9IHRoaXMucXVldWUuc2hpZnQoKTtcclxuICAgICAgICAgICAgaWYgKHRhc2spIHtcclxuICAgICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5jdXJyZW50VGFzayA9IHRhc2s7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKHRhc2sudGltZW91dCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB0YXNrLnRpbWVvdXRIYW5kbGUgPSBzZXRUaW1lb3V0KFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKCkgPT4ge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuZW1pdChzZXF1ZW50aWFsVGFza1F1ZXVlRXZlbnRzLnRpbWVvdXQpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuY2FuY2VsVGFzayh0YXNrLCBjYW5jZWxsYXRpb25Ub2tlblJlYXNvbnMudGltZW91dCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LCBcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhc2sudGltZW91dCk7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIGxldCByZXMgPSB0YXNrLmNhbGxiYWNrLmFwcGx5KHVuZGVmaW5lZCwgdGFzay5hcmdzKTtcclxuICAgICAgICAgICAgICAgICAgICBpZiAocmVzICYmIGlzUHJvbWlzZShyZXMpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlcy50aGVuKCgpID0+IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmRvbmVUYXNrKHRhc2spO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVyciA9PiB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5kb25lVGFzayh0YXNrLCBlcnIpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuZG9uZVRhc2sodGFzayk7XHJcblxyXG4gICAgICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuZG9uZVRhc2sodGFzaywgZSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAvLyBxdWV1ZSBpcyBlbXB0eSwgY2FsbCB3YWl0ZXJzXHJcbiAgICAgICAgICAgICAgICB0aGlzLmNhbGxXYWl0ZXJzKCk7IFxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgY2FuY2VsVGFzayh0YXNrOiBUYXNrRW50cnksIHJlYXNvbj86IGFueSkge1xyXG4gICAgICAgIHRhc2suY2FuY2VsbGF0aW9uVG9rZW4uY2FuY2VsbGVkID0gdHJ1ZTtcclxuICAgICAgICB0YXNrLmNhbmNlbGxhdGlvblRva2VuLnJlYXNvbiA9IHJlYXNvbjtcclxuICAgICAgICB0aGlzLmRvbmVUYXNrKHRhc2spO1xyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgZG9uZVRhc2sodGFzazogVGFza0VudHJ5LCBlcnJvcj86IGFueSkge1xyXG4gICAgICAgIGlmICh0YXNrLnRpbWVvdXRIYW5kbGUpXHJcbiAgICAgICAgICAgIGNsZWFyVGltZW91dCh0YXNrLnRpbWVvdXRIYW5kbGUpO1xyXG4gICAgICAgIHRhc2suY2FuY2VsbGF0aW9uVG9rZW4uY2FuY2VsID0gbm9vcDtcclxuICAgICAgICBpZiAoZXJyb3IpXHJcbiAgICAgICAgICAgIHRoaXMuZW1pdChzZXF1ZW50aWFsVGFza1F1ZXVlRXZlbnRzLmVycm9yLCBlcnJvcik7XHJcbiAgICAgICAgaWYgKHRoaXMuY3VycmVudFRhc2sgPT09IHRhc2spIHtcclxuICAgICAgICAgICAgdGhpcy5jdXJyZW50VGFzayA9IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgaWYgKCF0aGlzLnF1ZXVlLmxlbmd0aCkge1xyXG4gICAgICAgICAgICAgICAgdGhpcy5lbWl0KHNlcXVlbnRpYWxUYXNrUXVldWVFdmVudHMuZHJhaW5lZCk7XHJcbiAgICAgICAgICAgICAgICB0aGlzLmNhbGxXYWl0ZXJzKCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZWxzZVxyXG4gICAgICAgICAgICAgICAgdGhpcy5zY2hlZHVsZXIuc2NoZWR1bGUoKCkgPT4gdGhpcy5uZXh0KCkpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIGNhbGxXYWl0ZXJzKCkge1xyXG4gICAgICAgIGxldCB3YWl0ZXJzID0gdGhpcy53YWl0ZXJzLnNwbGljZSgwKTtcclxuICAgICAgICB3YWl0ZXJzLmZvckVhY2god2FpdGVyID0+IHdhaXRlcigpKTtcclxuICAgIH1cclxufVxyXG5cclxuaW50ZXJmYWNlIFRhc2tFbnRyeSB7XHJcbiAgICBhcmdzOiBhbnlbXTtcclxuICAgIGNhbGxiYWNrOiBGdW5jdGlvbjtcclxuICAgIHRpbWVvdXQ/OiBudW1iZXI7XHJcbiAgICB0aW1lb3V0SGFuZGxlPzogYW55O1xyXG4gICAgY2FuY2VsbGF0aW9uVG9rZW46IENhbmNlbGxhdGlvblRva2VuO1xyXG59XHJcblxyXG5mdW5jdGlvbiBub29wKCkge1xyXG59XHJcblxyXG5mdW5jdGlvbiBpc1Byb21pc2Uob2JqOiBhbnkpOiBvYmogaXMgUHJvbWlzZUxpa2U8YW55PiB7XHJcbiAgICByZXR1cm4gKG9iaiAmJiB0eXBlb2Ygb2JqLnRoZW4gPT09IFwiZnVuY3Rpb25cIik7XHJcbn1cclxuXHJcblxyXG5cclxuXHJcblxyXG5cclxuXHJcblxyXG5cclxuXHJcblxyXG5cclxuXHJcblxyXG5cclxuIl0sInNvdXJjZVJvb3QiOiIvc291cmNlLyJ9
