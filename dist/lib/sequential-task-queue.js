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
        this.scheduler = options.scheduler || SequentialTaskQueue.defaultScheduler;
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

//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInNlcXVlbnRpYWwtdGFzay1xdWV1ZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBMkVBOzs7O0dBSUc7QUFDUSxnQ0FBd0IsR0FBRztJQUNsQyxtR0FBbUc7SUFDbkcsTUFBTSxFQUFFLE1BQU0sQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDO0lBQzNCLG9FQUFvRTtJQUNwRSxPQUFPLEVBQUUsTUFBTSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUM7Q0FDL0IsQ0FBQTtBQUVEOztHQUVHO0FBQ1EsaUNBQXlCLEdBQUc7SUFDbkMsT0FBTyxFQUFFLFNBQVM7SUFDbEIsS0FBSyxFQUFFLE9BQU87SUFDZCxPQUFPLEVBQUUsU0FBUztDQUNyQixDQUFBO0FBRUQ7O0dBRUc7QUFDSDtJQXFCSTs7O01BR0U7SUFDRixZQUFZLE9BQW9DO1FBbkJ4QyxVQUFLLEdBQWdCLEVBQUUsQ0FBQztRQUN4QixjQUFTLEdBQVksS0FBSyxDQUFDO1FBQzNCLFlBQU8sR0FBZSxFQUFFLENBQUM7UUFrQjdCLEVBQUUsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDO1lBQ1QsT0FBTyxHQUFHLEVBQUUsQ0FBQztRQUNqQixJQUFJLENBQUMsY0FBYyxHQUFHLE9BQU8sQ0FBQyxPQUFPLENBQUM7UUFDdEMsSUFBSSxDQUFDLElBQUksR0FBRyxPQUFPLENBQUMsSUFBSSxJQUFJLHFCQUFxQixDQUFDO1FBQ2xELElBQUksQ0FBQyxTQUFTLEdBQUcsT0FBTyxDQUFDLFNBQVMsSUFBSSxtQkFBbUIsQ0FBQyxnQkFBZ0IsQ0FBQztJQUMvRSxDQUFDO0lBZkQsc0lBQXNJO0lBQ3RJLElBQUksUUFBUTtRQUNSLE1BQU0sQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDO0lBQzFCLENBQUM7SUFjRDs7Ozs7T0FLRztJQUNILElBQUksQ0FBQyxJQUFjLEVBQUUsT0FBcUI7UUFDdEMsRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQztZQUNmLE1BQU0sSUFBSSxLQUFLLENBQUMsR0FBRyxJQUFJLENBQUMsSUFBSSw2QkFBNkIsQ0FBQyxDQUFDO1FBQy9ELElBQUksU0FBUyxHQUFjO1lBQ3ZCLFFBQVEsRUFBRSxJQUFJO1lBQ2QsSUFBSSxFQUFFLE9BQU8sSUFBSSxPQUFPLENBQUMsSUFBSSxHQUFHLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLEdBQUcsT0FBTyxDQUFDLElBQUksQ0FBQyxLQUFLLEVBQUUsR0FBRyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxHQUFHLEVBQUU7WUFDMUcsT0FBTyxFQUFFLE9BQU8sSUFBSSxPQUFPLENBQUMsT0FBTyxLQUFLLFNBQVMsR0FBRyxPQUFPLENBQUMsT0FBTyxHQUFHLElBQUksQ0FBQyxjQUFjO1lBQ3pGLGlCQUFpQixFQUFFO2dCQUNmLE1BQU0sRUFBRSxDQUFDLE1BQU8sS0FBSyxJQUFJLENBQUMsVUFBVSxDQUFDLFNBQVMsRUFBRSxNQUFNLENBQUM7YUFDMUQ7U0FDSixDQUFDO1FBQ0YsU0FBUyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLGlCQUFpQixDQUFDLENBQUM7UUFDakQsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDM0IsSUFBSSxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUMsTUFBTSxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQztRQUMzQyxNQUFNLENBQUMsU0FBUyxDQUFDLGlCQUFpQixDQUFDO0lBQ3ZDLENBQUM7SUFFRDs7O09BR0c7SUFDSCxNQUFNO1FBQ0YsRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQztZQUNqQixJQUFJLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxXQUFXLEVBQUUsZ0NBQXdCLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDdkUsZ0VBQWdFO1FBQ2hFLEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQztZQUM1QixJQUFJLENBQUMsSUFBSSxDQUFDLGlDQUF5QixDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQ2pELE1BQU0sQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUM7SUFDdkIsQ0FBQztJQUVEOzs7OztPQUtHO0lBQ0gsS0FBSyxDQUFDLE1BQWdCO1FBQ2xCLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUM7WUFDbEIsSUFBSSxDQUFDLFNBQVMsR0FBRyxJQUFJLENBQUM7WUFDdEIsRUFBRSxDQUFDLENBQUMsTUFBTSxDQUFDO2dCQUNQLE1BQU0sQ0FBQyxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUM7UUFDN0IsQ0FBQztRQUNELE1BQU0sQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUM7SUFDdkIsQ0FBQztJQUVEOzs7T0FHRztJQUNILElBQUk7UUFDQSxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxXQUFXLElBQUksSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLEtBQUssQ0FBQyxDQUFDO1lBQzdDLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxFQUFFLENBQUM7UUFDN0IsTUFBTSxDQUFDLElBQUksT0FBTyxDQUFDLE9BQU87WUFDdEIsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7UUFDL0IsQ0FBQyxDQUFDLENBQUM7SUFDUCxDQUFDO0lBRUQ7Ozs7T0FJRztJQUNILEVBQUUsQ0FBQyxHQUFXLEVBQUUsT0FBaUI7UUFDN0IsSUFBSSxDQUFDLE1BQU0sR0FBRyxJQUFJLENBQUMsTUFBTSxJQUFJLEVBQUUsQ0FBQztRQUNoQyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQ2hFLENBQUM7SUFFRDs7OztPQUlHO0lBQ0gsSUFBSSxDQUFDLEdBQVcsRUFBRSxPQUFpQjtRQUMvQixJQUFJLEVBQUUsR0FBRyxDQUFDLEdBQUcsSUFBVztZQUNwQixJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxFQUFFLENBQUMsQ0FBQztZQUNsQixPQUFPLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsQ0FBQztRQUM5QixDQUFDLENBQUM7UUFDRixJQUFJLENBQUMsRUFBRSxDQUFDLEdBQUcsRUFBRSxFQUFFLENBQUMsQ0FBQztJQUNyQixDQUFDO0lBRUQ7Ozs7T0FJRztJQUNILEdBQUcsQ0FBQyxHQUFXLEVBQUUsT0FBaUI7UUFDOUIsRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUM7WUFDZCxJQUFJLElBQUksR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1lBQzVCLEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7Z0JBQ1AsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO2dCQUNWLE9BQU8sQ0FBQyxHQUFHLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQztvQkFDckIsRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxLQUFLLE9BQU8sQ0FBQzt3QkFDcEIsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7b0JBQ3RCLElBQUk7d0JBQ0EsQ0FBQyxFQUFFLENBQUM7Z0JBQ1osQ0FBQztZQUNMLENBQUM7UUFDTCxDQUFDO0lBQ0wsQ0FBQztJQUVPLElBQUksQ0FBQyxHQUFXLEVBQUUsR0FBRyxJQUFXO1FBQ3BDLEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxNQUFNLElBQUksSUFBSSxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQztZQUNoQyxJQUFJLENBQUM7Z0JBQ0QsSUFBSSxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxPQUFPLENBQUMsRUFBRSxJQUFJLEVBQUUsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxDQUFDLENBQUM7WUFDekQsQ0FBRTtZQUFBLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7Z0JBQ1QsT0FBTyxDQUFDLEtBQUssQ0FBQyxHQUFHLElBQUksQ0FBQyxJQUFJLG1CQUFtQixHQUFHLGlCQUFpQixFQUFFLENBQUMsQ0FBQyxDQUFDO1lBQzFFLENBQUM7SUFDVCxDQUFDO0lBRU8sSUFBSTtRQUNSLDJEQUEyRDtRQUMzRCxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDO1lBQ3BCLElBQUksSUFBSSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxFQUFFLENBQUM7WUFDOUIsdUJBQXVCO1lBQ3ZCLE9BQU8sSUFBSSxJQUFJLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxTQUFTO2dCQUMzQyxJQUFJLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLEVBQUUsQ0FBQztZQUM5QixFQUFFLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO2dCQUNQLElBQUksQ0FBQztvQkFDRCxJQUFJLENBQUMsV0FBVyxHQUFHLElBQUksQ0FBQztvQkFDeEIsRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7d0JBQ2YsSUFBSSxDQUFDLGFBQWEsR0FBRyxVQUFVLENBQzNCOzRCQUNJLElBQUksQ0FBQyxJQUFJLENBQUMsaUNBQXlCLENBQUMsT0FBTyxDQUFDLENBQUM7NEJBQzdDLElBQUksQ0FBQyxVQUFVLENBQUMsSUFBSSxFQUFFLGdDQUF3QixDQUFDLE9BQU8sQ0FBQyxDQUFDO3dCQUM1RCxDQUFDLEVBQ0QsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDO29CQUN0QixDQUFDO29CQUNELElBQUksR0FBRyxHQUFHLElBQUksQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLFNBQVMsRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7b0JBQ3BELEVBQUUsQ0FBQyxDQUFDLEdBQUcsSUFBSSxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO3dCQUN4QixHQUFHLENBQUMsSUFBSSxDQUFDOzRCQUNELElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUM7d0JBQ3hCLENBQUMsRUFDRCxHQUFHOzRCQUNDLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLEdBQUcsQ0FBQyxDQUFDO3dCQUM3QixDQUFDLENBQUMsQ0FBQztvQkFDWCxDQUFDO29CQUFDLElBQUk7d0JBQ0YsSUFBSSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFFNUIsQ0FBRTtnQkFBQSxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO29CQUNULElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDO2dCQUMzQixDQUFDO1lBQ0wsQ0FBQztZQUFDLElBQUksQ0FBQyxDQUFDO2dCQUNKLCtCQUErQjtnQkFDL0IsSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDO1lBQ3ZCLENBQUM7UUFDTCxDQUFDO0lBQ0wsQ0FBQztJQUVPLFVBQVUsQ0FBQyxJQUFlLEVBQUUsTUFBWTtRQUM1QyxJQUFJLENBQUMsaUJBQWlCLENBQUMsU0FBUyxHQUFHLElBQUksQ0FBQztRQUN4QyxJQUFJLENBQUMsaUJBQWlCLENBQUMsTUFBTSxHQUFHLE1BQU0sQ0FBQztRQUN2QyxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ3hCLENBQUM7SUFFTyxRQUFRLENBQUMsSUFBZSxFQUFFLEtBQVc7UUFDekMsRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQztZQUNuQixZQUFZLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxDQUFDO1FBQ3JDLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDO1FBQ3JDLEVBQUUsQ0FBQyxDQUFDLEtBQUssQ0FBQztZQUNOLElBQUksQ0FBQyxJQUFJLENBQUMsaUNBQXlCLENBQUMsS0FBSyxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQ3RELEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxXQUFXLEtBQUssSUFBSSxDQUFDLENBQUMsQ0FBQztZQUM1QixJQUFJLENBQUMsV0FBVyxHQUFHLFNBQVMsQ0FBQztZQUM3QixFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQztnQkFDckIsSUFBSSxDQUFDLElBQUksQ0FBQyxpQ0FBeUIsQ0FBQyxPQUFPLENBQUMsQ0FBQztnQkFDN0MsSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDO1lBQ3ZCLENBQUM7WUFDRCxJQUFJO2dCQUNBLElBQUksQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLE1BQU0sSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDLENBQUM7UUFDbkQsQ0FBQztJQUNMLENBQUM7SUFFTyxXQUFXO1FBQ2YsSUFBSSxPQUFPLEdBQUcsSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDckMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxNQUFNLElBQUksTUFBTSxFQUFFLENBQUMsQ0FBQztJQUN4QyxDQUFDO0FBQ0wsQ0FBQztBQXBOVSxvQ0FBZ0IsR0FBYztJQUNqQyxRQUFRLEVBQUUsUUFBUSxJQUFJLFVBQVUsQ0FBTSxRQUFRLEVBQUUsQ0FBQyxDQUFDO0NBQ3JELENBQUM7QUFKTywyQkFBbUIsc0JBc04vQixDQUFBO0FBVUQ7QUFDQSxDQUFDO0FBRUQsbUJBQW1CLEdBQVE7SUFDdkIsTUFBTSxDQUFDLENBQUMsR0FBRyxJQUFJLE9BQU8sR0FBRyxDQUFDLElBQUksS0FBSyxVQUFVLENBQUMsQ0FBQztBQUNuRCxDQUFDO0FBRUQsbUJBQW1CLENBQUMsZ0JBQWdCLEdBQUc7SUFDbkMsUUFBUSxFQUFFLE9BQU8sWUFBWSxLQUFLLFVBQVU7VUFDdEMsUUFBUSxJQUFJLFlBQVksQ0FBMkIsUUFBUSxDQUFDO1VBQzVELFFBQVEsSUFBSSxVQUFVLENBQTJCLFFBQVEsRUFBRSxDQUFDLENBQUM7Q0FDdEUsQ0FBQyIsImZpbGUiOiJzZXF1ZW50aWFsLXRhc2stcXVldWUuanMiLCJzb3VyY2VzQ29udGVudCI6WyIvKiogXHJcbiAqIFJlcHJlc2VudHMgYW4gb2JqZWN0IHRoYXQgc2NoZWR1bGVzIGEgZnVuY3Rpb24gZm9yIGFzeW5jaHJvbm91cyBleGVjdXRpb24uXHJcbiAqIFRoZSBkZWZhdWx0IGltcGxlbWVudGF0aW9uIHVzZWQgYnkge0BsaW5rIFNlcXVlbnRpYWxUYXNrUXVldWV9IGNhbGxzIHtAbGluayBzZXRJbW1lZGlhdGV9IHdoZW4gYXZhaWxhYmxlLFxyXG4gKiBhbmQge0BsaW5rIHNldFRpbWVvdXR9IG90aGVyd2lzZS5cclxuICogQHNlZSB7QGxpbmsgU2VxdWVudGlhbFRhc2tRdWV1ZS5kZWZhdWx0U2NoZWR1bGVyfVxyXG4gKiBAc2VlIHtAbGluayBUYXNrUXVldWVPcHRpb25zI3NjaGVkdWxlcn1cclxuICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgU2NoZWR1bGVyIHtcclxuICAgIC8qKlxyXG4gICAgICogU2NoZWR1bGVzIGEgY2FsbGJhY2sgZm9yIGFzeW5jaHJvbm91cyBleGVjdXRpb24uXHJcbiAgICAgKi9cclxuICAgIHNjaGVkdWxlKGNhbGxiYWNrOiBGdW5jdGlvbik6IHZvaWQ7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBPYmplY3QgdXNlZCBmb3IgcGFzc2luZyBjb25maWd1cmF0aW9uIG9wdGlvbnMgdG8gdGhlIHtAbGluayBTZXF1ZW50aWFsVGFza1F1ZXVlfSBjb25zdHJ1Y3Rvci5cclxuICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgU2VxdWVudGlhbFRhc2tRdWV1ZU9wdGlvbnMge1xyXG4gICAgLyoqXHJcbiAgICAgKiBBc3NpZ25zIGEgbmFtZSB0byB0aGUgdGFzayBxdWV1ZSBmb3IgZGlhZ25vc3RpYyBwdXJwb3Nlcy4gVGhlIG5hbWUgZG9lcyBub3QgbmVlZCB0byBiZSB1bmlxdWUuXHJcbiAgICAgKi9cclxuICAgIG5hbWU/OiBzdHJpbmc7XHJcbiAgICAvKipcclxuICAgICAqIERlZmF1bHQgdGltZW91dCAoaW4gbWlsbGlzZWNvbmRzKSBmb3IgdGFza3MgcHVzaGVkIHRvIHRoZSBxdWV1ZS4gRGVmYXVsdCBpcyAwIChubyB0aW1lb3V0KS5cclxuICAgICAqICAqLyAgICBcclxuICAgIHRpbWVvdXQ/OiBudW1iZXI7XHJcbiAgICAvKipcclxuICAgICAqIFNjaGVkdWxlciB1c2VkIGJ5IHRoZSBxdWV1ZS4gRGVmYXVsdHMgdG8ge0BsaW5rIFNlcXVlbnRpYWxUYXNrUXVldWUuZGVmYXVsdFNjaGVkdWxlcn0uIFxyXG4gICAgICovXHJcbiAgICBzY2hlZHVsZXI/OiBTY2hlZHVsZXI7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBPcHRpb25zIG9iamVjdCBmb3IgaW5kaXZpZHVhbCB0YXNrcy5cclxuICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgVGFza09wdGlvbnMge1xyXG4gICAgLyoqXHJcbiAgICAgKiBUaW1lb3V0IGZvciB0aGUgdGFzaywgaW4gbWlsbGlzZWNvbmRzLiBcclxuICAgICAqICovXHJcbiAgICB0aW1lb3V0PzogbnVtYmVyO1xyXG5cclxuICAgIC8qKlxyXG4gICAgICogQXJndW1lbnRzIHRvIHBhc3MgdG8gdGhlIHRhc2suIFVzZWZ1bCBmb3IgbWluaW1hbGlzaW5nIHRoZSBudW1iZXIgb2YgRnVuY3Rpb24gb2JqZWN0cyBhbmQgY2xvc3VyZXMgY3JlYXRlZCBcclxuICAgICAqIHdoZW4gcHVzaGluZyB0aGUgc2FtZSB0YXNrIG11bHRpcGxlIHRpbWVzLCB3aXRoIGRpZmZlcmVudCBhcmd1bWVudHMuICBcclxuICAgICAqIFxyXG4gICAgICogQGV4YW1wbGVcclxuICAgICAqIC8vIFRoZSBmb2xsb3dpbmcgY29kZSBjcmVhdGVzIGEgc2luZ2xlIEZ1bmN0aW9uIG9iamVjdCBhbmQgbm8gY2xvc3VyZXM6XHJcbiAgICAgKiBmb3IgKGxldCBpID0gMDsgaSA8IDEwMDsgaSsrKVxyXG4gICAgICogICAgIHF1ZXVlLnB1c2gocHJvY2Vzcywge2FyZ3M6IFtpXX0pO1xyXG4gICAgICogZnVuY3Rpb24gcHJvY2VzcyhuKSB7XHJcbiAgICAgKiAgICAgY29uc29sZS5sb2cobik7XHJcbiAgICAgKiB9XHJcbiAgICAgKi9cclxuICAgIGFyZ3M/OiBhbnk7ICAgIFxyXG59XHJcblxyXG4vKipcclxuICogUHJvdmlkZXMgdGhlIEFQSSBmb3IgcXVlcnlpbmcgYW5kIGludm9raW5nIHRhc2sgY2FuY2VsbGF0aW9uLlxyXG4gKi9cclxuZXhwb3J0IGludGVyZmFjZSBDYW5jZWxsYXRpb25Ub2tlbiB7XHJcbiAgICAvKipcclxuICAgICAqIFdoZW4gYHRydWVgLCBpbmRpY2F0ZXMgdGhhdCB0aGUgdGFzayBoYXMgYmVlbiBjYW5jZWxsZWQuIFxyXG4gICAgICovXHJcbiAgICBjYW5jZWxsZWQ/OiBib29sZWFuO1xyXG4gICAgLyoqXHJcbiAgICAgKiBBbiBhcmJpdHJhcnkgb2JqZWN0IHJlcHJlc2VudGluZyB0aGUgcmVhc29uIG9mIHRoZSBjYW5jZWxsYXRpb24uIENhbiBiZSBhIG1lbWJlciBvZiB0aGUge0BsaW5rIGNhbmNlbGxhdGlvblRva2VuUmVhc29uc30gb2JqZWN0IG9yIGFuIGBFcnJvcmAsIGV0Yy4gIFxyXG4gICAgICovXHJcbiAgICByZWFzb24/OiBhbnk7XHJcbiAgICAvKipcclxuICAgICAqIENhbmNlbHMgdGhlIHRhc2sgZm9yIHdoaWNoIHRoZSBjYW5jZWxsYXRpb24gdG9rZW4gd2FzIGNyZWF0ZWQuXHJcbiAgICAgKiBAcGFyYW0gcmVhc29uIC0gVGhlIHJlYXNvbiBvZiB0aGUgY2FuY2VsbGF0aW9uLCBzZWUge0BsaW5rIENhbmNlbGxhdGlvblRva2VuI3JlYXNvbn0gXHJcbiAgICAgKi9cclxuICAgIGNhbmNlbChyZWFzb24/OiBhbnkpO1xyXG59XHJcblxyXG4vKipcclxuICogU3RhbmRhcmQgY2FuY2VsbGF0aW9uIHJlYXNvbnMuIHtAbGluayBTZXF1ZW50aWFsVGFza1F1ZXVlfSBzZXRzIHtAbGluayBDYW5jZWxsYXRpb25Ub2tlbiNyZWFzb259IFxyXG4gKiB0byBvbmUgb2YgdGhlc2UgdmFsdWVzIHdoZW4gY2FuY2VsbGluZyBhIHRhc2sgZm9yIGEgcmVhc29uIG90aGVyIHRoYW4gdGhlIHVzZXIgY29kZSBjYWxsaW5nXHJcbiAqIHtAbGluayBDYW5jZWxsYXRpb25Ub2tlbiNjYW5jZWx9LiAgICBcclxuICovXHJcbmV4cG9ydCB2YXIgY2FuY2VsbGF0aW9uVG9rZW5SZWFzb25zID0ge1xyXG4gICAgLyoqIFVzZWQgd2hlbiB0aGUgdGFzayB3YXMgY2FuY2VsbGVkIGluIHJlc3BvbnNlIHRvIGEgY2FsbCB0byB7QGxpbmsgU2VxdWVudGlhbFRhc2tRdWV1ZSNjYW5jZWx9ICovXHJcbiAgICBjYW5jZWw6IE9iamVjdC5jcmVhdGUobnVsbCksXHJcbiAgICAvKiogVXNlZCB3aGVuIHRoZSB0YXNrIHdhcyBjYW5jZWxsZWQgYWZ0ZXIgaXRzIHRpbWVvdXQgaGFzIHBhc3NlZCAqL1xyXG4gICAgdGltZW91dDogT2JqZWN0LmNyZWF0ZShudWxsKVxyXG59XHJcblxyXG4vKipcclxuICogU3RhbmRhcmQgZXZlbnQgbmFtZXMgdXNlZCBieSB7QGxpbmsgU2VxdWVudGlhbFRhc2tRdWV1ZX1cclxuICovXHJcbmV4cG9ydCB2YXIgc2VxdWVudGlhbFRhc2tRdWV1ZUV2ZW50cyA9IHtcclxuICAgIGRyYWluZWQ6IFwiZHJhaW5lZFwiLFxyXG4gICAgZXJyb3I6IFwiZXJyb3JcIixcclxuICAgIHRpbWVvdXQ6IFwidGltZW91dFwiXHJcbn1cclxuXHJcbi8qKlxyXG4gKiBGSUZPIHRhc2sgcXVldWUgdG8gcnVuIHRhc2tzIGluIHByZWRpY3RhYmxlIG9yZGVyLCB3aXRob3V0IGNvbmN1cnJlbmN5LlxyXG4gKi9cclxuZXhwb3J0IGNsYXNzIFNlcXVlbnRpYWxUYXNrUXVldWUge1xyXG5cclxuICAgIHN0YXRpYyBkZWZhdWx0U2NoZWR1bGVyOiBTY2hlZHVsZXIgPSB7XHJcbiAgICAgICAgc2NoZWR1bGU6IGNhbGxiYWNrID0+IHNldFRpbWVvdXQoPGFueT5jYWxsYmFjaywgMClcclxuICAgIH07XHJcblxyXG4gICAgcHJpdmF0ZSBxdWV1ZTogVGFza0VudHJ5W10gPSBbXTtcclxuICAgIHByaXZhdGUgX2lzQ2xvc2VkOiBib29sZWFuID0gZmFsc2U7XHJcbiAgICBwcml2YXRlIHdhaXRlcnM6IEZ1bmN0aW9uW10gPSBbXTtcclxuICAgIHByaXZhdGUgZGVmYXVsdFRpbWVvdXQ6IG51bWJlcjtcclxuICAgIHByaXZhdGUgY3VycmVudFRhc2s6IFRhc2tFbnRyeTtcclxuICAgIHByaXZhdGUgc2NoZWR1bGVyOiBTY2hlZHVsZXI7XHJcbiAgICBwcml2YXRlIGV2ZW50czogeyBba2V5OiBzdHJpbmddOiBGdW5jdGlvbltdIH07XHJcblxyXG4gICAgbmFtZTogc3RyaW5nO1xyXG5cclxuICAgIC8qKiBJbmRpY2F0ZXMgaWYgdGhlIHF1ZXVlIGhhcyBiZWVuIGNsb3NlZC4gQ2FsbGluZyB7QGxpbmsgU2VxdWVudGlhbFRhc2tRdWV1ZSNwdXNofSBvbiBhIGNsb3NlZCBxdWV1ZSB3aWxsIHJlc3VsdCBpbiBhbiBleGNlcHRpb24uICovXHJcbiAgICBnZXQgaXNDbG9zZWQoKSB7XHJcbiAgICAgICAgcmV0dXJuIHRoaXMuX2lzQ2xvc2VkO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKiBcclxuICAgICAqIENyZWF0ZXMgYSBuZXcgaW5zdGFuY2Ugb2Yge0BsaW5rIFNlcXVlbnRpYWxUYXNrUXVldWV9XHJcbiAgICAgKiBAcGFyYW0ge1Rhc2tRdWV1ZU9wdGlvbnN9IG9wdGlvbnMgLSBDb25maWd1cmF0aW9uIG9wdGlvbnMgZm9yIHRoZSB0YXNrIHF1ZXVlLlxyXG4gICAgKi9cclxuICAgIGNvbnN0cnVjdG9yKG9wdGlvbnM/OiBTZXF1ZW50aWFsVGFza1F1ZXVlT3B0aW9ucykge1xyXG4gICAgICAgIGlmICghb3B0aW9ucylcclxuICAgICAgICAgICAgb3B0aW9ucyA9IHt9O1xyXG4gICAgICAgIHRoaXMuZGVmYXVsdFRpbWVvdXQgPSBvcHRpb25zLnRpbWVvdXQ7XHJcbiAgICAgICAgdGhpcy5uYW1lID0gb3B0aW9ucy5uYW1lIHx8IFwiU2VxdWVudGlhbFRhc2tRdWV1ZVwiO1xyXG4gICAgICAgIHRoaXMuc2NoZWR1bGVyID0gb3B0aW9ucy5zY2hlZHVsZXIgfHwgU2VxdWVudGlhbFRhc2tRdWV1ZS5kZWZhdWx0U2NoZWR1bGVyO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICogQWRkcyBhIG5ldyB0YXNrIHRvIHRoZSBxdWV1ZS5cclxuICAgICAqIEBwYXJhbSB7RnVuY3Rpb259IHRhc2sgLSBUaGUgZnVuY3Rpb24gdG8gY2FsbCB3aGVuIHRoZSB0YXNrIGlzIHJ1blxyXG4gICAgICogQHBhcmFtIHtudW1iZXJ9IHRpbWVvdXQgLSBBbiBvcHRpb25hbCB0aW1lb3V0IChpbiBtaWxsaXNlY29uZHMpIGZvciB0aGUgdGFzaywgYWZ0ZXIgd2hpY2ggaXQgc2hvdWxkIGJlIGNhbmNlbGxlZCB0byBhdm9pZCBoYW5naW5nIHRhc2tzIGNsb2dnaW5nIHVwIHRoZSBxdWV1ZS4gXHJcbiAgICAgKiBAcmV0dXJucyBBIHtAbGluayBDYW5jZWxsYXRpb25Ub2tlbn0gdGhhdCBtYXkgYmUgdXNlZCB0byBjYW5jZWwgdGhlIHRhc2sgYmVmb3JlIGl0IGNvbXBsZXRlcy5cclxuICAgICAqL1xyXG4gICAgcHVzaCh0YXNrOiBGdW5jdGlvbiwgb3B0aW9ucz86IFRhc2tPcHRpb25zKTogQ2FuY2VsbGF0aW9uVG9rZW4ge1xyXG4gICAgICAgIGlmICh0aGlzLl9pc0Nsb3NlZClcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGAke3RoaXMubmFtZX0gaGFzIGJlZW4gcHJldmlvdXNseSBjbG9zZWRgKTtcclxuICAgICAgICB2YXIgdGFza0VudHJ5OiBUYXNrRW50cnkgPSB7XHJcbiAgICAgICAgICAgIGNhbGxiYWNrOiB0YXNrLFxyXG4gICAgICAgICAgICBhcmdzOiBvcHRpb25zICYmIG9wdGlvbnMuYXJncyA/IChBcnJheS5pc0FycmF5KG9wdGlvbnMuYXJncykgPyBvcHRpb25zLmFyZ3Muc2xpY2UoKSA6IFtvcHRpb25zLmFyZ3NdKSA6IFtdLFxyXG4gICAgICAgICAgICB0aW1lb3V0OiBvcHRpb25zICYmIG9wdGlvbnMudGltZW91dCAhPT0gdW5kZWZpbmVkID8gb3B0aW9ucy50aW1lb3V0IDogdGhpcy5kZWZhdWx0VGltZW91dCxcclxuICAgICAgICAgICAgY2FuY2VsbGF0aW9uVG9rZW46IHtcclxuICAgICAgICAgICAgICAgIGNhbmNlbDogKHJlYXNvbj8pID0+IHRoaXMuY2FuY2VsVGFzayh0YXNrRW50cnksIHJlYXNvbilcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH07XHJcbiAgICAgICAgdGFza0VudHJ5LmFyZ3MucHVzaCh0YXNrRW50cnkuY2FuY2VsbGF0aW9uVG9rZW4pO1xyXG4gICAgICAgIHRoaXMucXVldWUucHVzaCh0YXNrRW50cnkpO1xyXG4gICAgICAgIHRoaXMuc2NoZWR1bGVyLnNjaGVkdWxlKCgpID0+IHRoaXMubmV4dCgpKTtcclxuICAgICAgICByZXR1cm4gdGFza0VudHJ5LmNhbmNlbGxhdGlvblRva2VuO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICogQ2FuY2VscyB0aGUgY3VycmVudGx5IHJ1bm5pbmcgdGFzayAoaWYgYW55KSwgYW5kIGNsZWFycyB0aGUgcXVldWUuXHJcbiAgICAgKiBAcmV0dXJucyB7UHJvbWlzZX0gQSBQcm9taXNlIHRoYXQgaXMgZnVsZmlsbGVkIHdoZW4gdGhlIHF1ZXVlIGlzIGVtcHR5IGFuZCB0aGUgY3VycmVudCB0YXNrIGhhcyBiZWVuIGNhbmNlbGxlZC5cclxuICAgICAqL1xyXG4gICAgY2FuY2VsKCk6IFByb21pc2VMaWtlPGFueT4ge1xyXG4gICAgICAgIGlmICh0aGlzLmN1cnJlbnRUYXNrKSBcclxuICAgICAgICAgICAgdGhpcy5jYW5jZWxUYXNrKHRoaXMuY3VycmVudFRhc2ssIGNhbmNlbGxhdGlvblRva2VuUmVhc29ucy5jYW5jZWwpO1xyXG4gICAgICAgIC8vIGVtaXQgYSBkcmFpbmVkIGV2ZW50IGlmIHRoZXJlIHdlcmUgdGFza3Mgd2FpdGluZyBpbiB0aGUgcXVldWVcclxuICAgICAgICBpZiAodGhpcy5xdWV1ZS5zcGxpY2UoMCkubGVuZ3RoKVxyXG4gICAgICAgICAgICB0aGlzLmVtaXQoc2VxdWVudGlhbFRhc2tRdWV1ZUV2ZW50cy5kcmFpbmVkKTtcclxuICAgICAgICByZXR1cm4gdGhpcy53YWl0KCk7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBDbG9zZXMgdGhlIHF1ZXVlLCBwcmV2ZW50aW5nIG5ldyB0YXNrcyB0byBiZSBhZGRlZC4gXHJcbiAgICAgKiBBbnkgY2FsbHMgdG8ge0BsaW5rIFNlcXVlbnRpYWxUYXNrUXVldWUjcHVzaH0gYWZ0ZXIgY2xvc2luZyB0aGUgcXVldWUgd2lsbCByZXN1bHQgaW4gYW4gZXhjZXB0aW9uLlxyXG4gICAgICogQHBhcmFtIHtib29sZWFufSBjYW5jZWwgLSBJbmRpY2F0ZXMgdGhhdCB0aGUgcXVldWUgc2hvdWxkIGFsc28gYmUgY2FuY2VsbGVkLlxyXG4gICAgICogQHJldHVybnMge1Byb21pc2V9IEEgUHJvbWlzZSB0aGF0IGlzIGZ1bGZpbGxlZCB3aGVuIHRoZSBxdWV1ZSBoYXMgZmluaXNoZWQgZXhlY3V0aW5nIHJlbWFpbmluZyB0YXNrcy4gIFxyXG4gICAgICovXHJcbiAgICBjbG9zZShjYW5jZWw/OiBib29sZWFuKTogUHJvbWlzZUxpa2U8YW55PiB7XHJcbiAgICAgICAgaWYgKCF0aGlzLl9pc0Nsb3NlZCkge1xyXG4gICAgICAgICAgICB0aGlzLl9pc0Nsb3NlZCA9IHRydWU7XHJcbiAgICAgICAgICAgIGlmIChjYW5jZWwpXHJcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5jYW5jZWwoKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHRoaXMud2FpdCgpO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICogUmV0dXJucyBhIHByb21pc2UgdGhhdCBpcyBmdWxmaWxsZWQgd2hlbiB0aGUgcXVldWUgaXMgZW1wdHkuXHJcbiAgICAgKiBAcmV0dXJucyB7UHJvbWlzZX1cclxuICAgICAqL1xyXG4gICAgd2FpdCgpOiBQcm9taXNlTGlrZTxhbnk+IHtcclxuICAgICAgICBpZiAoIXRoaXMuY3VycmVudFRhc2sgJiYgdGhpcy5xdWV1ZS5sZW5ndGggPT09IDApXHJcbiAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcclxuICAgICAgICByZXR1cm4gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XHJcbiAgICAgICAgICAgIHRoaXMud2FpdGVycy5wdXNoKHJlc29sdmUpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICogQWRkcyBhbiBldmVudCBoYW5kbGVyIGZvciBhIG5hbWVkIGV2ZW50LlxyXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IGV2dCAtIEV2ZW50IG5hbWUuIFNlZSB0aGUgcmVhZG1lIGZvciBhIGxpc3Qgb2YgdmFsaWQgZXZlbnRzLlxyXG4gICAgICogQHBhcmFtIHtGdW5jdGlvbn0gaGFuZGxlciAtIEV2ZW50IGhhbmRsZXIuIFdoZW4gaW52b2tpbmcgdGhlIGhhbmRsZXIsIHRoZSBxdWV1ZSB3aWxsIHNldCBpdHNlbGYgYXMgdGhlIGB0aGlzYCBhcmd1bWVudCBvZiB0aGUgY2FsbC4gXHJcbiAgICAgKi9cclxuICAgIG9uKGV2dDogc3RyaW5nLCBoYW5kbGVyOiBGdW5jdGlvbikge1xyXG4gICAgICAgIHRoaXMuZXZlbnRzID0gdGhpcy5ldmVudHMgfHwge307XHJcbiAgICAgICAgKHRoaXMuZXZlbnRzW2V2dF0gfHwgKHRoaXMuZXZlbnRzW2V2dF0gPSBbXSkpLnB1c2goaGFuZGxlcik7ICAgICBcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIEFkZHMgYSBzaW5nbGUtc2hvdCBldmVudCBoYW5kbGVyIGZvciBhIG5hbWVkIGV2ZW50LlxyXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IGV2dCAtIEV2ZW50IG5hbWUuIFNlZSB0aGUgcmVhZG1lIGZvciBhIGxpc3Qgb2YgdmFsaWQgZXZlbnRzLlxyXG4gICAgICogQHBhcmFtIHtGdW5jdGlvbn0gaGFuZGxlciAtIEV2ZW50IGhhbmRsZXIuIFdoZW4gaW52b2tpbmcgdGhlIGhhbmRsZXIsIHRoZSBxdWV1ZSB3aWxsIHNldCBpdHNlbGYgYXMgdGhlIGB0aGlzYCBhcmd1bWVudCBvZiB0aGUgY2FsbC4gXHJcbiAgICAgKi9cclxuICAgIG9uY2UoZXZ0OiBzdHJpbmcsIGhhbmRsZXI6IEZ1bmN0aW9uKSB7XHJcbiAgICAgICAgdmFyIGNiID0gKC4uLmFyZ3M6IGFueVtdKSA9PiB7XHJcbiAgICAgICAgICAgIHRoaXMub2ZmKGV2dCwgY2IpO1xyXG4gICAgICAgICAgICBoYW5kbGVyLmFwcGx5KHRoaXMsIGFyZ3MpO1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgdGhpcy5vbihldnQsIGNiKTtcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIFJlbW92ZXMgYW4gZXZlbnQgaGFuZGxlci5cclxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBldnQgLSBFdmVudCBuYW1lXHJcbiAgICAgKiBAcGFyYW0ge0Z1bmN0aW9ufSBoYW5kbGVyIC0gRXZlbnQgaGFuZGxlciB0byBiZSByZW1vdmVkXHJcbiAgICAgKi9cclxuICAgIG9mZihldnQ6IHN0cmluZywgaGFuZGxlcjogRnVuY3Rpb24pIHtcclxuICAgICAgICBpZiAodGhpcy5ldmVudHMpIHtcclxuICAgICAgICAgICAgdmFyIGxpc3QgPSB0aGlzLmV2ZW50c1tldnRdO1xyXG4gICAgICAgICAgICBpZiAobGlzdCkge1xyXG4gICAgICAgICAgICAgICAgdmFyIGkgPSAwO1xyXG4gICAgICAgICAgICAgICAgd2hpbGUgKGkgPCBsaXN0Lmxlbmd0aCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChsaXN0W2ldID09PSBoYW5kbGVyKVxyXG4gICAgICAgICAgICAgICAgICAgICAgICBsaXN0LnNwbGljZShpLCAxKTtcclxuICAgICAgICAgICAgICAgICAgICBlbHNlXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGkrKztcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIGVtaXQoZXZ0OiBzdHJpbmcsIC4uLmFyZ3M6IGFueVtdKSB7XHJcbiAgICAgICAgaWYgKHRoaXMuZXZlbnRzICYmIHRoaXMuZXZlbnRzW2V2dF0pXHJcbiAgICAgICAgICAgIHRyeSB7IFxyXG4gICAgICAgICAgICAgICAgdGhpcy5ldmVudHNbZXZ0XS5mb3JFYWNoKGZuID0+IGZuLmFwcGx5KHRoaXMsIGFyZ3MpKTtcclxuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5lcnJvcihgJHt0aGlzLm5hbWV9OiBFeGNlcHRpb24gaW4gJyR7ZXZ0fScgZXZlbnQgaGFuZGxlcmAsIGUpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBuZXh0KCkge1xyXG4gICAgICAgIC8vIFRyeSBydW5uaW5nIHRoZSBuZXh0IHRhc2ssIGlmIG5vdCBjdXJyZW50bHkgcnVubmluZyBvbmUgXHJcbiAgICAgICAgaWYgKCF0aGlzLmN1cnJlbnRUYXNrKSB7XHJcbiAgICAgICAgICAgIHZhciB0YXNrID0gdGhpcy5xdWV1ZS5zaGlmdCgpO1xyXG4gICAgICAgICAgICAvLyBza2lwIGNhbmNlbGxlZCB0YXNrc1xyXG4gICAgICAgICAgICB3aGlsZSAodGFzayAmJiB0YXNrLmNhbmNlbGxhdGlvblRva2VuLmNhbmNlbGxlZClcclxuICAgICAgICAgICAgICAgIHRhc2sgPSB0aGlzLnF1ZXVlLnNoaWZ0KCk7XHJcbiAgICAgICAgICAgIGlmICh0YXNrKSB7XHJcbiAgICAgICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuY3VycmVudFRhc2sgPSB0YXNrO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmICh0YXNrLnRpbWVvdXQpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGFzay50aW1lb3V0SGFuZGxlID0gc2V0VGltZW91dChcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICgpID0+IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmVtaXQoc2VxdWVudGlhbFRhc2tRdWV1ZUV2ZW50cy50aW1lb3V0KTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmNhbmNlbFRhc2sodGFzaywgY2FuY2VsbGF0aW9uVG9rZW5SZWFzb25zLnRpbWVvdXQpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSwgXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YXNrLnRpbWVvdXQpO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICBsZXQgcmVzID0gdGFzay5jYWxsYmFjay5hcHBseSh1bmRlZmluZWQsIHRhc2suYXJncyk7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKHJlcyAmJiBpc1Byb21pc2UocmVzKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICByZXMudGhlbigoKSA9PiB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5kb25lVGFzayh0YXNrKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnIgPT4ge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuZG9uZVRhc2sodGFzaywgZXJyKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZVxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmRvbmVUYXNrKHRhc2spO1xyXG5cclxuICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcclxuICAgICAgICAgICAgICAgICAgICB0aGlzLmRvbmVUYXNrKHRhc2ssIGUpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgLy8gcXVldWUgaXMgZW1wdHksIGNhbGwgd2FpdGVyc1xyXG4gICAgICAgICAgICAgICAgdGhpcy5jYWxsV2FpdGVycygpOyBcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIGNhbmNlbFRhc2sodGFzazogVGFza0VudHJ5LCByZWFzb24/OiBhbnkpIHtcclxuICAgICAgICB0YXNrLmNhbmNlbGxhdGlvblRva2VuLmNhbmNlbGxlZCA9IHRydWU7XHJcbiAgICAgICAgdGFzay5jYW5jZWxsYXRpb25Ub2tlbi5yZWFzb24gPSByZWFzb247XHJcbiAgICAgICAgdGhpcy5kb25lVGFzayh0YXNrKTtcclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIGRvbmVUYXNrKHRhc2s6IFRhc2tFbnRyeSwgZXJyb3I/OiBhbnkpIHtcclxuICAgICAgICBpZiAodGFzay50aW1lb3V0SGFuZGxlKVxyXG4gICAgICAgICAgICBjbGVhclRpbWVvdXQodGFzay50aW1lb3V0SGFuZGxlKTtcclxuICAgICAgICB0YXNrLmNhbmNlbGxhdGlvblRva2VuLmNhbmNlbCA9IG5vb3A7XHJcbiAgICAgICAgaWYgKGVycm9yKVxyXG4gICAgICAgICAgICB0aGlzLmVtaXQoc2VxdWVudGlhbFRhc2tRdWV1ZUV2ZW50cy5lcnJvciwgZXJyb3IpO1xyXG4gICAgICAgIGlmICh0aGlzLmN1cnJlbnRUYXNrID09PSB0YXNrKSB7XHJcbiAgICAgICAgICAgIHRoaXMuY3VycmVudFRhc2sgPSB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgIGlmICghdGhpcy5xdWV1ZS5sZW5ndGgpIHtcclxuICAgICAgICAgICAgICAgIHRoaXMuZW1pdChzZXF1ZW50aWFsVGFza1F1ZXVlRXZlbnRzLmRyYWluZWQpO1xyXG4gICAgICAgICAgICAgICAgdGhpcy5jYWxsV2FpdGVycygpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGVsc2VcclxuICAgICAgICAgICAgICAgIHRoaXMuc2NoZWR1bGVyLnNjaGVkdWxlKCgpID0+IHRoaXMubmV4dCgpKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBjYWxsV2FpdGVycygpIHtcclxuICAgICAgICBsZXQgd2FpdGVycyA9IHRoaXMud2FpdGVycy5zcGxpY2UoMCk7XHJcbiAgICAgICAgd2FpdGVycy5mb3JFYWNoKHdhaXRlciA9PiB3YWl0ZXIoKSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmludGVyZmFjZSBUYXNrRW50cnkge1xyXG4gICAgYXJnczogYW55W107XHJcbiAgICBjYWxsYmFjazogRnVuY3Rpb247XHJcbiAgICB0aW1lb3V0PzogbnVtYmVyO1xyXG4gICAgdGltZW91dEhhbmRsZT86IGFueTtcclxuICAgIGNhbmNlbGxhdGlvblRva2VuOiBDYW5jZWxsYXRpb25Ub2tlbjtcclxufVxyXG5cclxuZnVuY3Rpb24gbm9vcCgpIHtcclxufVxyXG5cclxuZnVuY3Rpb24gaXNQcm9taXNlKG9iajogYW55KTogb2JqIGlzIFByb21pc2VMaWtlPGFueT4ge1xyXG4gICAgcmV0dXJuIChvYmogJiYgdHlwZW9mIG9iai50aGVuID09PSBcImZ1bmN0aW9uXCIpO1xyXG59XHJcblxyXG5TZXF1ZW50aWFsVGFza1F1ZXVlLmRlZmF1bHRTY2hlZHVsZXIgPSB7XHJcbiAgICBzY2hlZHVsZTogdHlwZW9mIHNldEltbWVkaWF0ZSA9PT0gXCJmdW5jdGlvblwiIFxyXG4gICAgICAgID8gY2FsbGJhY2sgPT4gc2V0SW1tZWRpYXRlKDwoLi4uYXJnczogYW55W10pID0+IHZvaWQ+Y2FsbGJhY2spXHJcbiAgICAgICAgOiBjYWxsYmFjayA9PiBzZXRUaW1lb3V0KDwoLi4uYXJnczogYW55W10pID0+IHZvaWQ+Y2FsbGJhY2ssIDApXHJcbn07XHJcblxyXG5cclxuXHJcblxyXG5cclxuXHJcblxyXG5cclxuXHJcblxyXG5cclxuXHJcblxyXG4iXSwic291cmNlUm9vdCI6Ii9zb3VyY2UvIn0=
