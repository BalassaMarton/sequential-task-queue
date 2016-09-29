var gulp = require("gulp");
var ts = require("gulp-typescript");
var mocha = require("gulp-mocha");
var sourceMaps = require("gulp-sourcemaps");
var snip = require("snip-text");
var template = require("gulp-template");
var rename = require("gulp-rename");
var fs = require("fs");
var del = require("del");

gulp.task("clean:dist", function() {
    return del("dist/**/*");
});

gulp.task("clean:tsc", function() {
    return del(["src/**/*.js", "test/**/*.js"]);
});

gulp.task("tsc", ["clean:tsc"], function(){
    var proj = ts.createProject("tsconfig.json");
    return gulp.src(["src/*.ts", "test/*.ts"])
        .pipe(sourceMaps.init())
        .pipe(proj()).js
        .pipe(sourceMaps.write())
        .pipe(gulp.dest(function(file) {
           return file.base; 
        }));
});

gulp.task("test-examples", function() {
    var proj = ts.createProject("tsconfig.json");
    return del("examples/**/*.js")
        .then(() => {
            return gulp.src(["examples/*.ts"])
                .pipe(proj()).js
                .pipe(gulp.dest("examples"))
                .pipe(mocha({}));
        }); 
});

gulp.task("doc:readme", ["test-examples"], function() {
    var examples = fs.readFileSync("examples/examples.ts", "utf8");
    var data = {
        examples: snip(examples, { unindent: true })
    };
    return gulp.src("doc/readme.template.md")
        .pipe(template(data))
        .pipe(rename(function(path){
            path.basename = path.basename.replace(".template", "");
            return path;
        }))
        .pipe(gulp.dest("."));
});

gulp.task("doc", ["doc:readme"], function(){});

gulp.task("test", ["tsc"], function() {
    return gulp.src("./test/*.js")
        .pipe(mocha({}));
});

gulp.task("build", ["clean:dist", "doc"], function() {
    var proj = ts.createProject("tsconfig.json");
    var result = gulp.src("src/*.ts")
        .pipe(sourceMaps.init())
        .pipe(proj());
    result.dts.pipe(gulp.dest("dist/types"));
    result.js
        .pipe(sourceMaps.write())
        .pipe(gulp.dest("dist/lib"));
});
