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

gulp.task("tsc", () => {
    var proj = ts.createProject("tsconfig.json");
    return gulp.src(["./src/*.ts", "./test/*.ts", "./examples/*.ts"])
        .pipe(sourceMaps.init())
        .pipe(proj()).js
        .pipe(sourceMaps.write())
        .pipe(gulp.dest(file => file.base));
});

gulp.task("doc:readme", function() {
    var examples = fs.readFileSync("./examples/examples.ts", "utf8");
    var data = {
        examples: snip(examples, { unindent: true })
    };
    return gulp.src("./src/*.template.md")
        .pipe(template(data))
        .pipe(rename(path => {
            path.basename = path.basename.replace(".template", "");
            return path;
        }))
        .pipe(gulp.dest("."));
});

gulp.task("clean:api", function() {
    return del("./doc/api");
});

gulp.task("doc:api", ["clean:api"], function(){
    return gulp.src("./src/*.ts")
        .pipe(typedoc({
            target: "es6",
            out: "./doc/api",
            name: "SequentialTaskQueue",
        }));
});

gulp.task("doc", ["doc:readme", "doc:api"], () => {});

gulp.task("test", ["tsc"], () => {
    return gulp.src(["./test/*.js", "./examples/*.js"])
        .pipe(mocha({}));
});

gulp.task("build", () => {
    var proj = ts.createProject("./tsconfig.json");
    var result = gulp.src("./src/*.ts")
        .pipe(sourceMaps.init())
        .pipe(proj());
    result.dts.pipe(gulp.dest("./dist/types"));
    result.js
        .pipe(sourceMaps.write())
        .pipe(gulp.dest("./dist/lib"));
});

gulp.task("prepublish", () => {
    return sequence("build", "test", "doc");
});