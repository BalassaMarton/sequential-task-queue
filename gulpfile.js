var gulp = require("gulp");
var ts = require("gulp-typescript");
var mocha = require("gulp-mocha");
var sourceMaps = require("gulp-sourcemaps");
var snip = require("snip-text");
var template = require("gulp-template");
var rename = require("gulp-rename");
var fs = require("fs");
var del = require("del");
var sequence = require("run-sequence");
var typedoc = require("gulp-typedoc");
var vinylPaths = require("vinyl-paths");

var globs = {
    build: ["./src/**/*.ts"],
    testSource: ["./src/**/*.ts", "./test/**/*.ts", "./examples/**/*.ts"],
    test: ["./test/**/*.js"],
    docTemplates: ["./src/*.template.md"]
};

gulp.task("doc:readme", function () {
    var examples = fs.readFileSync("./examples/examples.ts", "utf8");
    var data = {
        examples: snip(examples, { unindent: true })
    };
    return gulp.src(globs.docTemplates)
        .pipe(template(data))
        .pipe(rename(path => {
            path.basename = path.basename.replace(".template", "");
            return path;
        }))
        .pipe(gulp.dest("."));
});

gulp.task("clean:api", function () {
    return del("./doc/api");
});

gulp.task("doc:api", ["clean:api"], function () {
    return gulp.src(globs.build)
        .pipe(typedoc({
            target: "es6",
            out: "./doc/api",
            name: "SequentialTaskQueue",
        }));
});

gulp.task("doc", ["doc:readme", "doc:api"], () => { });

gulp.task("test-compile", () => {
    var proj = ts.createProject("tsconfig.json");

    return gulp.src(globs.testSource)
        .pipe(sourceMaps.init())
        .pipe(proj())
        .js
        .pipe(sourceMaps.write(".", { includeContent: false, sourceRoot: "." }))
        .pipe(gulp.dest(path => {
            return path.base;
        }));
});

gulp.task("test-run", () => {
    return gulp.src(globs.test)
        .pipe(mocha());
});

gulp.task("test-run-debug", () => {
    return gulp.src(globs.test)
        .pipe(mocha({ enableTimeouts: false }));
});

gulp.task("test-clean", () => {
    var p1 = gulp.src(globs.testSource)
        .pipe(rename(path => {
            if (path.extname == ".ts")
                path.extname = ".js";
        }))
        .pipe(vinylPaths(del));
    var p2 = gulp.src(globs.testSource)
        .pipe(rename(path => {
            if (path.extname == ".ts")
                path.extname = ".js.map";
        }))
        .pipe(vinylPaths(del));
    return Promise.all([p1, p2]);
});

gulp.task("test", () => {
    return sequence("test-compile", "test-run", "test-clean");
});

gulp.task("test-debug-exit", () => {
    process.exit();
});

gulp.task("test-debug", () => {
    return sequence("test-compile", "test-run-debug", "test-clean", "test-debug-exit");
});

gulp.task("clean", () => {
    return del(["dist/**/*"]);
});

gulp.task("build-ts", () => {
    var proj = ts.createProject("tsconfig.json");
    var result = gulp.src(globs.build)
        .pipe(proj());
    return result.js.pipe(gulp.dest("dist/lib"));
});

gulp.task("build-dts", () => {
    var proj = ts.createProject("tsconfig.json", { target: "es6" });
    var result = gulp.src(globs.build)
        .pipe(proj());
    return result.dts.pipe(gulp.dest("dist/types"));
});

gulp.task("build", () => sequence("clean", "build-ts", "build-dts"));

gulp.task("prepublish", () => {
    return sequence("build", "test", "doc");
});