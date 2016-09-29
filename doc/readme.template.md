# SequentialTaskQueue

`SequentialTaskQueue` is a FIFO task queue for node and the browser. It supports promises, timeouts and task cancellation.

The primary goal of this component is to allow asynchronous tasks to be executed in a strict, predictable order. 
This is especially useful when the application state is frequently mutated in response to asynchronous events.

## Basic usage

Use `push` to add tasks to the queue:

```js
<%= examples["Basic usage"] %>
```

## Promises

If the function passed to `push` returns a promise, the queue will wait for that promise to fulfill before moving to the next task.
Rejected promises don't cause the queue to stop executing tasks, but are reported in the `error` event (see below).  

```js
<%= examples["Promises"] %>
```

## Task cancellation

Tasks waiting in the queue, as well as the currently executing task, can be cancelled. This is achieved by creating a `CancellationToken` object
for every task pushed to the queue, and passing it (to the task function) as the last argument. The task can then query the token's `cancelled` property to check if it
has been cancelled:

```js
<%= examples["Task cancellation"] %>
```

In the above example, the task is cancelled before the 100 ms timeout. 

When cancelling the current task, the queue will immediately schedule the next one. 
It is the task's responsibility to abort when the cancellation token is set, thus avoiding invalid application state.
Remember, the primary goal of the task queue is to run asynchronous tasks in a predictable order, without concurrency. 
The basic assumption is that if a task has been cancelled, it will not mutate the application state.  

## Timeouts

Tasks can be pushed into the queue with a timeout, after which the queue will cancel the task (the timer starts when the task is run).
The timeout value is supplied to `push` in the second argument, which is interpreted as an options object for the task:

```js
<%= examples["Timeouts"] %>
```

## Passing arguments to the task

In most scenarios, you will be using the queue to respond to frequent, asynchronous events. Consider the following code that processes push notifications
coming from a server:

```js
<%= examples["Arguments 1"] %>
```
 
Every time the event handler is called, it creates a new function (and a closure), which can lead to poor performance. 
Let's rewrite this, now using the `args` property of the task options:

```js
<%= examples["Arguments 2"] %>
```

If the `args` member of the options object is an array, the queue will pass the elements of the array as arguments, otherwise
the value is interpreted as the single argument to the task function. The cancellation token is always passed as the last argument.
The last bit also means that you can't simply push a function that has a rest (`...`) parameter, or uses the `arguments` object, 
since the cancellation token would be appended.   

## Waiting for all tasks to finish

Use the `wait` method to obtain a `Promise` that fulfills when the queue is empty:
  
```js
<%= examples["Wait"] %>
```

## Closing the queue

At certain points in your code, you may want to prevent adding more tasks to a queue (e.g. screen deactivation). 
The `close` method closes the queue (sets the `isClosed` property to `true`), and returns a `Promise` that fulfills when the queue is empty. 
Calling `push` on a closed queue will throw an exception. Optionally, `close` can cancel all remaining tasks: 
to do so, pass a truthful value as its first parameter.

```js
<%= examples["Close"] %>
```

## Handling errors

Errors thrown inside a task are reported in the queue's `error` event (see below in the Events section). 
Exceptions thrown in event handlers, however, are catched and ignored to avoid inifinite loops of error handling code.

## Events

`SequentialTaskQueue` implements the `on`, `off` and `once` methods of node's `EventEmitter` pattern. 

The following events are defined:
 
### error

The `error` event is emitted when a task throws an error or the `Promise` returned by the task is rejected. The error object is
passed as the first argument of the event handler.

### drained

The `drained` event is emitted when a task has finished executing, and the queue is empty. A cancelled queue will also emit this event.

### timeout

The `timeout` event is emitted when a task is cancelled due to an expired timeout. The event is emitted before calling `cancel` on the task's cancellation token.  