import * as assert from "assert";
import { SequentialTaskQueue, CancellationToken, cancellationTokenReasons } from "../src/sequential-task-queue";
import * as sinon from "sinon";

describe("SequentialTaskQueue", () => {

    it("should execute a task", () => {
        var queue = new SequentialTaskQueue();
        var spy = sinon.spy();
        queue.push(spy);
        return queue.wait().then(() => { assert(spy.called); });
    });

    it("should execute a task with args (array)", () => {
        var queue = new SequentialTaskQueue();
        var spy = sinon.spy();
        queue.push(spy, {args: [1, 2, 3]});
        queue.push(spy, {args: [4, 5, 6]});
        return queue.wait().then(() => {
            assert(spy.callCount == 2); 
            assert.deepEqual(spy.args[0].slice(0, 3), [1, 2, 3]);
            assert.deepEqual(spy.args[1].slice(0, 3), [4, 5, 6]); 
        });
    });

    it("should execute a task with args (single value)", () => {
        var queue = new SequentialTaskQueue();
        var spy = sinon.spy();
        queue.push(spy, { args: "foo" });
        queue.push(spy, { args: "bar" });
        return queue.wait().then(() => {
            assert(spy.callCount == 2); 
            assert.deepEqual(spy.args[0].slice(0, 1), ["foo"]);
            assert.deepEqual(spy.args[1].slice(0, 1), ["bar"]); 
        });
    });

    it("should execute a chain of tasks", function() {

        this.timeout(0);

        var results = [];

        function createTask(id: number) {
            return () => {
                results.push(id);
            };
        }

        function createAsyncTask(id: number) {
            return () => new Promise(resolve => {
                results.push(id);
                resolve();
            });
        }

        function createScheduledTask(id: number) {
            return () => new Promise(resolve => {
                setTimeout(() => {
                    results.push(id);
                    resolve();
                }, Math.floor(Math.random() * 100));
            });
        }

        var functions: Function[] = [createTask, createAsyncTask, createScheduledTask];

        var queue = new SequentialTaskQueue();
        var count = 10;
        var expected = [];
        var idx = 0;
        while (idx < count) {
            for (let i = 0; i < functions.length; i++) {
                for (let j = 0; j < functions.length; j++) {
                    expected.push(idx);
                    queue.push(functions[i](idx));
                    idx++;
                    expected.push(idx);
                    queue.push(functions[j](idx));
                    idx++;
                }
            }                
        }
        return queue.wait().then(() => assert.deepEqual(results, expected));

    });

    describe("# wait", () => {
        it("should resolve when queue is empty", () => {
            var queue = new SequentialTaskQueue();
            return queue.wait();
        });

        it("should resolve after synchronous task", () => {
            var queue = new SequentialTaskQueue();
            var spy = sinon.spy();
            queue.push(() => spy());
            return queue.wait().then(() => assert(spy.called));    
        });

        it("should resolve after previously resolved Promise", () => {
            var queue = new SequentialTaskQueue();
            queue.push(() => Promise.resolve());
            return queue.wait();
        });

        it("should resolve after resolved Promise", () => {
            var queue = new SequentialTaskQueue();
            queue.push(() => new Promise(resolve => { resolve(); }));
            return queue.wait();
        });

        it("should resolve after resolved deferred Promise", () => {
            var queue = new SequentialTaskQueue();
            queue.push(() => new Promise(resolve => {
                setTimeout(resolve, 50);
            }));
            return queue.wait();
        });

        it("should resolve after throw", () => {
            var queue = new SequentialTaskQueue();
            queue.push(() => {
                throw new Error();
            });
            return queue.wait();
        });

        it("should resolve after previously rejected Promise", () => {
            var queue = new SequentialTaskQueue();
            queue.push(() => Promise.reject("rejected"));
            return queue.wait();
        });

        it("should resolve after rejected Promise", () => {
            var queue = new SequentialTaskQueue();
            queue.push(() => new Promise((resolve, reject) => {
                reject();
            }));
            return queue.wait();
        });

        it("should resolve after rejected deferred Promise", () => {
            var queue = new SequentialTaskQueue();
            queue.push(() => new Promise((resolve, reject) => {
                setTimeout(reject, 50);
            }));
            return queue.wait();
        });

        it("should resolve after multiple calls", () => {
            var queue = new SequentialTaskQueue();
            queue.push(() => new Promise((resolve, reject) => {
                setTimeout(resolve, 50);
            }));
            var p1 = queue.wait();
            var p2 = queue.wait();
            var p3 = queue.wait().then(() =>queue.wait());
            return Promise.all([p1, p2, p3]);
        });

        it("should resolve after cancel", () => {
            var queue = new SequentialTaskQueue();
            queue.push(() => new Promise((resolve, reject) => {
                setTimeout(resolve, 50);
            }));
            queue.push(() => { });
            var p = queue.wait();
            queue.cancel();
            return p;
        });
    });

    describe("# event: error", () => {

        it("should notify of thrown error", () => {
            var queue = new SequentialTaskQueue();
            var spy = sinon.spy();
            queue.on("error", spy);
            queue.push(() => {
                throw "fail";
            });
            return queue.wait().then(() => { assert(spy.calledWith("fail")); });
        });

        it("should notify of previously rejected Promise", () => {
            var queue = new SequentialTaskQueue();
            var spy = sinon.spy();
            queue.on("error", spy);
            queue.push(() => Promise.reject("rejected"));
            return queue.wait().then(() => assert(spy.calledWith("rejected")));
        });

        it("should notify of rejected Promise", () => {
            var queue = new SequentialTaskQueue();
            var spy = sinon.spy();
            queue.on("error", spy);
            queue.push(() => new Promise((resolve, reject) => {
                reject("rejected");
            }));
            return queue.wait().then(() => assert(spy.calledWith("rejected")));
        });

        it("should notify of rejected deferred Promise", () => {
            var queue = new SequentialTaskQueue();
            var spy = sinon.spy();
            queue.on("error", spy);
            queue.push(() => new Promise((resolve, reject) => {
                setTimeout(() => reject("rejected"), 50);
            }));
            return queue.wait().then(() => assert(spy.calledWith("rejected")));
        });

        it("should catch and report exception in handler", () => {
            var queue = new SequentialTaskQueue();
            sinon.spy(console, "error");
            queue.on("error", () => {
                throw "Outer error";
            });
            queue.push(() => {
                throw "Inner error";
            });
            return queue.wait().then(() => {
                try {
                // hard coded this error message, see SequentialTaskQueue.emit if this test fails
                    assert((<Sinon.SinonSpy>console.error).calledWith("SequentialTaskQueue: Exception in 'error' event handler", "Outer error"));
                } finally {
                    (<Sinon.SinonSpy>console.error).restore();
                }
            });
        });
    });

    describe("# event: drained", () => {
        
        it("should notify when single-task chain has finished", () => {
            var queue = new SequentialTaskQueue();
            var spy = sinon.spy();
            queue.on("drained", spy);
            queue.push(() => {});
            return queue.wait().then(() => { assert(spy.called); });
        });

        it("should notify when all tasks have finished", () => {
            var queue = new SequentialTaskQueue();
            var spy = sinon.spy();
            queue.on("drained", () => spy("drained"));
            queue.push(() => {
                spy(1);
            });
            queue.push(() => new Promise(resolve => {
                setTimeout(() => {
                    spy(2);
                    resolve();
                }, 10)
            }));
            queue.push(() => {
                spy(3);
            });
            return queue.wait().then(() => { assert.deepEqual(spy.args, [[1], [2], [3], ["drained"]]); });
        });

        it("should notify after cancel", () => {
            var queue = new SequentialTaskQueue();
            var spy = sinon.spy();
            queue.on("drained", () => spy("drained"));
            queue.push(() => { spy(1) });
            queue.push(() => { spy(2) });
            return queue.cancel().then(() => { assert.deepEqual(spy.args, [["drained"]]); });
        });

        it("should not notify when empty queue is cancelled", () => {
            var queue = new SequentialTaskQueue();
            var spy = sinon.spy();
            queue.on("drained", spy);
            return queue.cancel().then(() => { assert(spy.notCalled); });
        });
    });

    describe("# event: timeout", () => {
        it("should notify on timeout", () => {
            var queue = new SequentialTaskQueue();
            var spy = sinon.spy();
            queue.on("timeout", () => spy("timeout"));
            queue.push((ct: CancellationToken) => new Promise(resolve => {
                setTimeout(() => {
                    if (!ct.cancelled) {
                        spy("hello");
                        resolve();
                    }
                }, 500);
            }), { timeout: 100 });
            return queue.wait().then(() => { assert.deepEqual(spy.args, [["timeout"]]) });
        });
    });

    describe("# cancel", () => {

        it("should prevent queued tasks from running", () => {
            var queue = new SequentialTaskQueue();
            var res = [];
            queue.push(() => res.push(1));
            queue.push(() => new Promise(resolve => {
                setTimeout(() => {
                    res.push(2);
                    resolve();
                }, 50);
            }));
            queue.push(() => new Promise(resolve => {
                setTimeout(() => {
                    res.push(3);
                    resolve();
                }, 10);
            }));
            return queue.cancel().then(() => {
                assert.deepEqual(res, []);
            });
        });

        it("should cancel current task", () => {
            var queue = new SequentialTaskQueue();
            var spy = sinon.spy();

            queue.push((ct: CancellationToken) => {
                queue.cancel();
                if (ct.cancelled)
                    return;
                spy();
            });
            return queue.wait().then(() => assert(spy.notCalled));
        });

        it("should cancel current deferred task", () => {
            var queue = new SequentialTaskQueue();
            var spy = sinon.spy();

            queue.push((ct: CancellationToken) => 
                new Promise((resolve, reject) => {
                    setTimeout(() => {
                            // cancel() should not have been cancelled at this point
                            if (ct.cancelled)
                                reject("cancelled");
                            else {
                                spy(1);
                                resolve();
                            }
                        },
                        10);
                }).then(() => new Promise((resolve, reject) => {
                    setTimeout(() => {
                            // cancel() should have been cancelled at this point
                            if (ct.cancelled)
                                reject("cancelled");
                            else {
                                spy(2);
                                resolve();
                            }
                        },
                        100);
            })));
            setTimeout(() => queue.cancel(), 50);
            return queue.wait().then(() => {
                assert(spy.calledWith(1) && !spy.calledWith(2));
            });
        });
    });

    describe("# timeout",
        () => {
            it("should cancel task after timeout",
                () => {
                    var queue = new SequentialTaskQueue();
                    var spy = sinon.spy();
                    var err = sinon.spy();
                    var timeouts = [50, 500, 50];
                    
                    function pushTask(id, delay) {
                        queue.push((ct: CancellationToken) => new Promise(resolve => {
                            setTimeout(() => {
                                if (!ct.cancelled)
                                    spy(id);
                                resolve();
                            }, delay)
                        }), { timeout: 200 });
                    }

                    pushTask(1, 50);
                    pushTask(2, 500);
                    pushTask(3, 50);

                    return queue.wait().then(() => {
                        assert.deepEqual(spy.args, [[1], [3]]);
                    });
                });
        });

    describe("# close", () => {

        it("should prevent adding more tasks", () => {

            var queue = new SequentialTaskQueue();
            queue.push(() => {});
            queue.close();
            assert.throws(() => {
                queue.push(() => {});
            });

        });

        it("should execute remaining tasks", () => {

            var queue = new SequentialTaskQueue();
            var res = [];
            queue.push(() => res.push(1));
            queue.push(() => res.push(2));
            queue.close();
            try {
                queue.push(() => res.push(3));
            } catch (e) {
            }
            return queue.wait().then(() => { assert.deepEqual(res, [1, 2]); });
        });

    });

    describe("# once", () => {

        it("should register single-shot event handler", () => {

            var queue = new SequentialTaskQueue();
            var spy = sinon.spy();
            queue.once("error", spy);
            queue.push(() => { throw new Error("1"); });
            queue.push(() => { throw new Error("2"); });
            return queue.wait().then(() => assert(spy.calledOnce));
        });

    });
});

describe("CancellationToken", () => {
    describe("# cancel", () => {
        it("should prevent task from running", () => {
            var queue = new SequentialTaskQueue();
            var res = [];
            queue.push(() => res.push(1));
            var ct = queue.push(() => res.push(2));
            queue.push(() => res.push(3));
            ct.cancel();
            return queue.wait().then(() => {
                assert.deepEqual(res, [1, 3]);
            });
        });

        it("should cancel running task and execute the next one immediately", () => {
            var clock = sinon.useFakeTimers();
            try
            {
                var queue = new SequentialTaskQueue();
                var res = [];
                queue.push(() => res.push(1));
                var ct = queue.push(token => new Promise((resolve, reject) => {
                    if (token.cancelled)
                        reject();
                    setTimeout(() => {
                        if (token.cancelled)
                            reject();
                        else {
                            res.push(2);
                            resolve();
                        }
                    }, 500);
                }));
                queue.push(() => res.push(3));
                clock.tick(100);
                ct.cancel();
                clock.tick(1000);
                assert.deepEqual(res, [1, 3]);
                queue.wait();
            } finally {
                clock.restore();
            }
        });
    });
});