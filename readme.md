# SequentialTaskQueue

`SequentialTaskQueue` is a FIFO task queue for node and the browser. It supports promises, timeouts and task cancellation.

The primary goal of this component is to allow asynchronous tasks to be executed in a strict, predictable order. 
This is especially useful when the application state is frequently mutated in response to asynchronous events.

## Basic usage

Use `push` to add tasks to the queue. The method returns a `Promise` that will fulfill when the task has been executed or cancelled.

```js
var queue = new SequentialTaskQueue();
queue.push(() => {
    console.log("first task");
});
queue.push(() => {
    console.log("second task");
});
```

## Promises

If the function passed to `push` returns a `Promise`, the queue will wait for it to fulfill before moving to the next task.
Rejected promises don't cause the queue to stop executing tasks, but are reported in the `error` event (see below).  

```js
var queue = new SequentialTaskQueue();
queue.push(() => {
    console.log("1");
});
queue.push(() => {
    return new Promise(resolve => {
        setTimeout(() => {
            console.log("2");
            resolve();
        }, 500);
    });
});
queue.push(() => {
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            console.log("3");
            reject();
        }, 100);
    });
});
queue.push(() => {
    console.log("4");
});

// Output:
// 1
// 2
// 3
// 4

```

## Task cancellation

Tasks waiting in the queue, as well as the currently executing task, can be cancelled. This is achieved by creating a `CancellationToken` object
for every task pushed to the queue, and passing it (to the task function) as the last argument. The task can then query the token's `cancelled` property to check if it
has been cancelled. The `Promise` returned by `push` is extended with a `cancel` method so that individual tasks can be cancelled.

```js
var queue = new SequentialTaskQueue();
var task = queue.push(token => {
    return new Promise((resolve, reject) => {
        setTimeout(resolve, 100);
    }).then(() => new Promise((resolve, reject) => {
        if (token.cancelled)
            reject();
        else
            resolve();
    })).then(() => {
        throw new Error("Should not ever get here");
    });
});
setTimeout(() => {
    task.cancel();
}, 50);
```

In the above example, the task is cancelled before the 100 ms timeout. 

When cancelling the current task, the queue will immediately schedule the next one, without waiting for the task to finish.
It is the task's responsibility to abort when the cancellation token is set, thus avoiding invalid application state.
When a task is cancelled, the corresponding `Promise` is rejected with the cancellation reason, regardless of where the task currently is in the execution chain (running, scheduled or queued).

## Timeouts

Tasks can be pushed into the queue with a timeout, after which the queue will cancel the task (the timer starts when the task is run, not when queued).
The timeout value is supplied to `push` in the second argument, which is interpreted as an options object for the task:

```js
var queue = new SequentialTaskQueue();
// ...
function onEcho(query) {
    queue.push(token => 
        backend.echo(query).then(response => {
            if (!token.cancelled) {
                state.addResponse("Server responded: " + response);
            }
        }), { timeout: 1000 });
}
```

## Passing arguments to the task

In most scenarios, you will be using the queue to respond to frequent, asynchronous events. Consider the following code that processes push notifications
coming from a server:

```js
backend.on("notification", (data) => {
    queue.push(() => {
        console.log(data);
        // todo: do something with data
    });
});
```
 
Every time the event handler is called, it creates a new function (and a closure), which can lead to poor performance. 
Let's rewrite this, now using the `args` property of the task options:

```js
backend.on("notification", (data) => {
    queue.push(handleNotifiation, { args: data });
});

function handleNotifiation(data) {
    console.log(data);
    // todo: do something with data
}
```

If the `args` member of the options object is an array, the queue will pass the elements of the array as arguments, otherwise
the value is interpreted as the single argument to the task function. The cancellation token is always passed as the last argument.
The last bit also means that you can't simply push a function that has a rest (`...`) parameter, or uses the `arguments` object, 
since the cancellation token would be appended.   

## Waiting for all tasks to finish

Use the `wait` method to obtain a `Promise` that fulfills when the queue is empty:
  
```js
var queue = new SequentialTaskQueue();
queue.push(task1);
queue.push(task2);
queue.push(task3);
queue.wait().then(() => { /*...*/ });
```

## Closing the queue

At certain points in your code, you may want to prevent adding more tasks to a queue (e.g. screen deactivation). 
The `close` method closes the queue (sets the `isClosed` property to `true`), and returns a `Promise` that fulfills when the queue is empty. 
Calling `push` on a closed queue will throw an exception. Optionally, `close` can cancel all remaining tasks: 
to do so, pass a truthful value as its first parameter.

```js
var queue = new SequentialTaskQueue();
// ...
function deactivate(done) {
    queue.close(true).then(done);                
} 
```

## Handling errors

Errors thrown inside a task are reported in the queue's `error` event (see below in the Events section). 
Exceptions thrown in event handlers, however, are catched and ignored to avoid inifinite loops of error handling code.

## Events

`SequentialTaskQueue` implements the `on`, `removeListener` (`off`) and `once` methods of node's `EventEmitter` pattern. 

The following events are defined:
 
### error

The `error` event is emitted when a task throws an error or the `Promise` returned by the task is rejected. The error object is
passed as the first argument of the event handler.

### drained

The `drained` event is emitted when a task has finished executing, and the queue is empty. A cancelled queue will also emit this event.

### timeout

The `timeout` event is emitted when a task is cancelled due to an expired timeout. The event is emitted before calling `cancel` on the task's cancellation token.  

---
## Changelog

### 1.2.1

`next` and `emit` are now protected instead of private.

### 1.2.0

`SequentialTaskQueue.push` now returns a `Promise`. Earlier versions only returned a cancellation token.

---
This file was generated using [gulp-template](http://github.com/sindresorhus/gulp-template) and [snip-text](http://github.com/BalassaMarton/snip-text)