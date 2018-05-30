/**
 * Represents an object that schedules a function for asynchronous execution.
 * The default implementation used by {@link SequentialTaskQueue} calls {@link setImmediate} when available,
 * and {@link setTimeout} otherwise.
 * @see {@link SequentialTaskQueue.defaultScheduler}
 * @see {@link TaskQueueOptions.scheduler}
 */
export interface Scheduler {
    /**
     * Schedules a callback for asynchronous execution.
     */
    schedule(callback: Function): void;
}
/**
 * Object used for passing configuration options to the {@link SequentialTaskQueue} constructor.
 */
export interface SequentialTaskQueueOptions {
    /**
     * Assigns a name to the task queue for diagnostic purposes. The name does not need to be unique.
     */
    name?: string;
    /**
     * Default timeout (in milliseconds) for tasks pushed to the queue. Default is 0 (no timeout).
     *  */
    timeout?: number;
    /**
     * Scheduler used by the queue. Defaults to {@link SequentialTaskQueue.defaultScheduler}.
     */
    scheduler?: Scheduler;
}
/**
 * Options object for individual tasks.
 */
export interface TaskOptions {
    /**
     * Timeout for the task, in milliseconds.
     * */
    timeout?: number;
    /**
     * Arguments to pass to the task. Useful for minimalising the number of Function objects and closures created
     * when pushing the same task multiple times, with different arguments.
     *
     * @example
     * // The following code creates a single Function object and no closures:
     * for (let i = 0; i < 100; i++)
     *     queue.push(process, {args: [i]});
     * function process(n) {
     *     console.log(n);
     * }
     */
    args?: any;
}
/**
 * Provides the API for querying and invoking task cancellation.
 */
export interface CancellationToken {
    /**
     * When `true`, indicates that the task has been cancelled.
     */
    cancelled?: boolean;
    /**
     * An arbitrary object representing the reason of the cancellation. Can be a member of the {@link cancellationTokenReasons} object or an `Error`, etc.
     */
    reason?: any;
    /**
     * Cancels the task for which the cancellation token was created.
     * @param reason - The reason of the cancellation, see {@link CancellationToken.reason}
     */
    cancel(reason?: any): any;
}
/**
 * Standard cancellation reasons. {@link SequentialTaskQueue} sets {@link CancellationToken.reason}
 * to one of these values when cancelling a task for a reason other than the user code calling
 * {@link CancellationToken.cancel}.
 */
export declare var cancellationTokenReasons: {
    cancel: any;
    timeout: any;
};
/**
 * Standard event names used by {@link SequentialTaskQueue}
 */
export declare var sequentialTaskQueueEvents: {
    drained: string;
    error: string;
    timeout: string;
};
/**
 * Promise interface with the ability to cancel.
 */
export interface CancellablePromiseLike<T> extends PromiseLike<T> {
    /**
     * Cancels (and consequently, rejects) the task associated with the Promise.
     * @param reason - Reason of the cancellation. This value will be passed when rejecting this Promise.
     */
    cancel(reason?: any): void;
}
/**
 * FIFO task queue to run tasks in predictable order, without concurrency.
 */
export declare class SequentialTaskQueue {
    static defaultScheduler: Scheduler;
    private queue;
    private _isClosed;
    private waiters;
    private defaultTimeout;
    private currentTask;
    private scheduler;
    private events;
    name: string;
    /** Indicates if the queue has been closed. Calling {@link SequentialTaskQueue.push} on a closed queue will result in an exception. */
    readonly isClosed: boolean;
    /**
     * Creates a new instance of {@link SequentialTaskQueue}
     * @param options - Configuration options for the task queue.
    */
    constructor(options?: SequentialTaskQueueOptions);
    /**
     * Adds a new task to the queue.
     * @param task - The function to call when the task is run
     * @param timeout - An optional timeout (in milliseconds) for the task, after which it should be cancelled to avoid hanging tasks clogging up the queue.
     * @returns A {@link CancellationToken} that may be used to cancel the task before it completes.
     */
    push(task: Function, options?: TaskOptions): CancellablePromiseLike<any>;
    /**
     * Cancels the currently running task (if any), and clears the queue.
     * @returns {Promise} A Promise that is fulfilled when the queue is empty and the current task has been cancelled.
     */
    cancel(): PromiseLike<any>;
    /**
     * Closes the queue, preventing new tasks to be added.
     * Any calls to {@link SequentialTaskQueue.push} after closing the queue will result in an exception.
     * @param {boolean} cancel - Indicates that the queue should also be cancelled.
     * @returns {Promise} A Promise that is fulfilled when the queue has finished executing remaining tasks.
     */
    close(cancel?: boolean): PromiseLike<any>;
    /**
     * Returns a promise that is fulfilled when the queue is empty.
     * @returns {Promise}
     */
    wait(): PromiseLike<any>;
    /**
     * Adds an event handler for a named event.
     * @param {string} evt - Event name. See the readme for a list of valid events.
     * @param {Function} handler - Event handler. When invoking the handler, the queue will set itself as the `this` argument of the call.
     */
    on(evt: string, handler: Function): void;
    /**
     * Adds a single-shot event handler for a named event.
     * @param {string} evt - Event name. See the readme for a list of valid events.
     * @param {Function} handler - Event handler. When invoking the handler, the queue will set itself as the `this` argument of the call.
     */
    once(evt: string, handler: Function): void;
    /**
     * Removes an event handler.
     * @param {string} evt - Event name
     * @param {Function} handler - Event handler to be removed
     */
    removeListener(evt: string, handler: Function): void;
    /** @see {@link SequentialTaskQueue.removeListener} */
    off(evt: string, handler: Function): void;
    protected emit(evt: string, ...args: any[]): void;
    protected next(): void;
    private cancelTask(task, reason?);
    private doneTask(task, error?);
    private callWaiters();
}
