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

gulp.task("tsc", function(){
    var proj = ts.createProject("tsconfig.json");
    return gulp.src(["./src/*.ts", "./test/*.ts", "./examples/*.ts"])
        .pipe(sourceMaps.init())
        .pipe(proj()).js
        .pipe(sourceMaps.write())
        .pipe(gulp.dest(function(file) {
           return file.base; 
        }));
});

gulp.task("doc:readme", function() {
    var examples = fs.readFileSync("./examples/examples.ts", "utf8");
    var data = {
        examples: snip(examples, { unindent: true })
    };
    return gulp.src("./doc/readme.template.md")
        .pipe(template(data))
        .pipe(rename(function(path){
            path.basename = path.basename.replace(".template", "");
            return path;
        }))
        .pipe(gulp.dest("."));
});

gulp.task("doc", ["doc:readme"], function(){});

gulp.task("test", ["tsc"], function() {
    return gulp.src(["./test/*.js", "./examples/*.js"])
        .pipe(mocha({}));
});

gulp.task("build", function() {
    var proj = ts.createProject("./tsconfig.json");
    var result = gulp.src("./src/*.ts")
        .pipe(sourceMaps.init())
        .pipe(proj());
    result.dts.pipe(gulp.dest("./dist/types"));
    result.js
        .pipe(sourceMaps.write())
        .pipe(gulp.dest("./dist/lib"));
});

gulp.task("prepublish", function(){
    return sequence("build", "test", "doc");
});