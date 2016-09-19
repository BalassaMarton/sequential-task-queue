import * as assert from "assert";
import {SequentialTaskQueue, ICancellationToken, cancellationTokenReasons } from "../src/sequential-task-queue";
import * as sinon from "sinon";
describe("SequentialTaskQueue", () => {

    it("should execute a task", () => {
        var queue = new SequentialTaskQueue();
        var spy = sinon.spy();
        queue.push(spy);
        return queue.wait().then(() => { assert(spy.called); });
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

    describe("# onError", () => {

        it("should notify of thrown error", () => {
            var queue = new SequentialTaskQueue();
            var spy = sinon.spy();
            queue.onError(spy);
            queue.push(() => {
                throw "fail";
            });
            return queue.wait().then(() => { assert(spy.calledWith("fail")); });
        });

        it("should notify of previously rejected Promise", () => {
            var queue = new SequentialTaskQueue();
            var spy = sinon.spy();
            queue.onError(spy);
            queue.push(() => Promise.reject("rejected"));
            return queue.wait().then(() => assert(spy.calledWith("rejected")));
        });

        it("should notify of rejected Promise", () => {
            var queue = new SequentialTaskQueue();
            var spy = sinon.spy();
            queue.onError(spy);
            queue.push(() => new Promise((resolve, reject) => {
                reject("rejected");
            }));
            return queue.wait().then(() => assert(spy.calledWith("rejected")));
        });

        it("should notify of rejected deferred Promise", () => {
            var queue = new SequentialTaskQueue();
            var spy = sinon.spy();
            queue.onError(spy);
            queue.push(() => new Promise((resolve, reject) => {
                setTimeout(() => reject("rejected"), 50);
            }));
            return queue.wait().then(() => assert(spy.calledWith("rejected")));
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

            queue.push((ct: ICancellationToken) => {
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

            queue.push((ct: ICancellationToken) => new Promise((resolve, reject) => {
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
                    queue.onError(spy);
                    queue.push((ct: ICancellationToken) => {
                        return new Promise((resolve, reject) => {
                            setTimeout(() => {
                                    if (ct.cancelled)
                                        reject(ct.reason);
                                    else {
                                        resolve();
                                    }
                                },
                                500);
                        });
                    }, 100);
                    return new Promise(resolve => {
                            setTimeout(resolve, 1000);
                        }).then(() => queue.wait())
                        .then(() => assert(spy.calledWith(cancellationTokenReasons.timeout)));
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
});

