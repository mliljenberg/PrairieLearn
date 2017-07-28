var ERR = require('async-stacktrace');
var async = require('async');
var _ = require('lodash');
var fs = require('fs');
var path = require('path');
var child_process = require('child_process');
var handlebars = require('handlebars');
var cheerio = require('cheerio');

var elements = require('./elements');

module.exports = {
    getElementFilename: function(elementName) {
        if (!elements.has(elementName)) {
            return 'No such element: "' + elementName + '"';
        }
        const elementModule = elements.get(elementName);
        return path.join(__dirname, 'elements', elementModule);
    },

    elementFunction: function(fcn, elementName, $, element, index, data, callback) {
        const jsArgs = [$, element, index, data];
        const elementHtml = $(element).clone().wrap('<container/>').parent().html();
        const pythonArgs = [elementHtml, index, data];
        if (!elements.has(elementName)) {
            return callback(null, 'ERROR: invalid element name: ' + elementName);
        }
        const elementModule = elements.get(elementName);
        if (_.isString(elementModule)) {
            // python module
            const pythonFile = elementModule.replace(/\.[pP][yY]$/, '');
            const pythonCwd = path.join(__dirname, 'elements');
            this.execPython(pythonFile, fcn, pythonArgs, pythonCwd, (err, ret, consoleLog) => {
                if (ERR(err, callback)) return;
                callback(null, ret, consoleLog);
            });
        } else {
            // JS module
            elementModule[fcn](...jsArgs, (err, ret) => {
                if (ERR(err, callback)) return;
                callback(null, ret, '');
            });
        }
    },

    renderExtraHeaders: function(question, course, locals, callback) {
        callback(null, '');
    },

    execPython: function(pythonFile, pythonFunction, pythonArgs, pythonCwd, callback) {
        var cmdInput = {
            file: pythonFile,
            fcn: pythonFunction,
            args: pythonArgs,
            cwd: pythonCwd,
            pylibdir: path.join(__dirname, 'freeformPythonLib'),
        };
        try {
            var input = JSON.stringify(cmdInput);
        } catch (e) {
            var err = new Error('Error encoding question JSON');
            err.data = {endcodeMsg: e.message, cmdInput};
            return ERR(err, callback);
        }
        var cmdOptions = {
            cwd: pythonCwd,
            input: input,
            timeout: 10000, // milliseconds
            killSignal: 'SIGKILL',
            stdio: ['pipe', 'pipe', 'pipe', 'pipe'], // stdin, stdout, stderr, and an extra one for data
        };
        var cmd = 'python';
        var args = [__dirname + '/python_caller.py'];
        var child = child_process.spawn(cmd, args, cmdOptions);

        child.stderr.setEncoding('utf8');
        child.stdout.setEncoding('utf8');
        child.stdio[3].setEncoding('utf8');

        var outputStdout = '';
        var outputStderr = '';
        var outputBoth = '';
        var outputData = '';

        child.stdout.on('data', (data) => {
            outputStdout += data;
            outputBoth += data;

            // Temporary fix to write stderr to console while waiting for this
            // to be displayed in browser
            /* eslint-disable no-console */
            console.log('FIXME');
            console.log(data);
            /* eslint-enable no-console */
        });

        child.stderr.on('data', (data) => {
            outputStderr += data;
            outputBoth += data;

            // Temporary fix to write stderr to console while waiting for this
            // to be displayed in browser
            /* eslint-disable no-console */
            console.log('FIXME');
            console.log(data);
            /* eslint-enable no-console */
        });

        child.stdio[3].on('data', (data) => {
            outputData += data;
        });

        var callbackCalled = false;

        child.on('close', (code) => {
            let err, output;
            if (code) {
                err = new Error('Error in question code execution');
                err.data = {code, cmdInput, outputStdout, outputStderr, outputBoth, outputData};
                if (!callbackCalled) {
                    callbackCalled = true;
                    return ERR(err, callback);
                } else {
                    // FIXME: silently swallowing the error here
                    return;
                }
            }
            try {
                output = JSON.parse(outputData);
            } catch (e) {
                err = new Error('Error decoding question JSON: ' + e.message);
                err.data = {decodeMsg: e.message, cmdInput, outputStdout, outputStderr, outputBoth, outputData};
                if (!callbackCalled) {
                    callbackCalled = true;
                    return ERR(err, callback);
                } else {
                    // FIXME: silently swallowing the error here
                    return;
                }
            }
            if (!callbackCalled) {
                callbackCalled = true;
                callback(null, output, outputBoth);
            } else {
                // FIXME: silently swallowing the output here
                return;
            }
        });

        child.on('error', (error) => {
            let err = new Error('Error executing python question code: ' + error.message);
            err.data = {execMsg: error.message, cmdInput, outputStdout, outputStderr, outputBoth};
            if (!callbackCalled) {
                callbackCalled = true;
                return ERR(err, callback);
            } else {
                // FIXME: silently swallowing the error here
                return;
            }
        });

        child.stdin.write(input);
        child.stdin.end();
    },

    execPythonServer: function(pythonFunction, pythonArgs, question, course, callback) {
        var question_dir = path.join(course.path, 'questions', question.directory);
        this.execPython('server', pythonFunction, pythonArgs, question_dir, (err, output) => {
            if (ERR(err, callback)) return;
            callback(null, output);
        });
    },

    makeHandlebars: function() {
        var hb = handlebars.create();
        return hb;
    },

    execTemplate: function(filename, data, question, course, callback) {
        var question_dir = path.join(course.path, 'questions', question.directory);
        var question_html = path.join(question_dir, filename);
        fs.readFile(question_html, {encoding: 'utf8'}, (err, raw_file) => {
            if (ERR(err, callback)) return;
            try {
                var hb = this.makeHandlebars();
                var template = hb.compile(raw_file);
            } catch (err) {
                err.data = {data, question, course};
                return ERR(err, callback);
            }
            var html;
            try {
                html = template(data);
            } catch (err) {
                err.data = {data, question, course};
                return ERR(err, callback);
            }
            var $;
            try {
                $ = cheerio.load(html, {
                    recognizeSelfClosing: true,
                });
            } catch (err) {
                err.data = {data, question, course};
                return ERR(err, callback);
            }
            callback(null, html, $);
        });
    },

    checkQuestionData: function(data, checkOptions) {
        const checked = [];
        const checkProp = (prop, type) => {
            if (!_.has(data, prop)) return '"' + prop + '" is missing from "data"';
            if (type == 'integer') {
                if (!_.isInteger(data[prop])) {
                    return 'data.' + prop + ' is not an integer: ' + String(data[prop]);
                }
            } else if (type == 'number') {
                if (!_.isFinite(data[prop])) {
                    return 'data.' + prop + ' is not a number: ' + String(data[prop]);
                }
            } else if (type == 'string') {
                if (!_.isString(data[prop])) {
                    return 'data.' + prop + ' is not a string: ' + String(data[prop]);
                }
            } else if (type == 'boolean') {
                if (!_.isBoolean(data[prop])) {
                    return 'data.' + prop + ' is not a boolean: ' + String(data[prop]);
                }
            } else if (type == 'object') {
                if (!_.isObject(data[prop])) {
                    return 'data.' + prop + ' is not an object: ' + String(data[prop]);
                }
            } else {
                return 'invalid type: ' + String(type);
            }
            checked.push(prop);
            return null;
        };

        let err;
        err = checkProp('params', 'object'); if (err) return err;
        err = checkProp('correct_answers', 'object'); if (err) return err;
        err = checkProp('variant_seed', 'integer'); if (err) return err;
        err = checkProp('options', 'object'); if (err) return err;
        if (checkOptions.has_submission) {
            err = checkProp('submitted_answers', 'object'); if (err) return err;
            err = checkProp('parse_errors', 'object'); if (err) return err;
            err = checkProp('raw_submitted_answers', 'object'); if (err) return err;
        }
        if (checkOptions.has_grading) {
            err = checkProp('partial_scores', 'object'); if (err) return err;
            err = checkProp('score', 'number'); if (err) return err;
            err = checkProp('feedback', 'object'); if (err) return err;
        }
        if (checkOptions.for_render) {
            err = checkProp('editable', 'boolean'); if (err) return err;
            err = checkProp('panel', 'string'); if (err) return err;
        }
        const extraProps = _.difference(_.keys(data), checked);
        if (extraProps.length > 0) return '"data" has invalid extra keys: ' + extraProps.join(', ');

        return null;
    },

    getData: function(question, course, variant_seed, callback) {
        const question_dir = path.join(course.path, 'questions', question.directory);
        let consoleLog = '';
        let data = {
            params: {},
            correct_answers: {},
            variant_seed: parseInt(variant_seed, 36),
            options: _.defaults({}, course.options, question.options),
        };

        const checkOptions = {has_submission: false, has_grading: false, for_render: false};
        const checkErr = module.exports.checkQuestionData(data, checkOptions);
        if (checkErr) {
            consoleLog += 'Invalid state before server.get_data(): ' + checkErr + '\n';
            return callback(null, data, false, consoleLog);
        }

        let pythonArgs = [data];
        this.execPythonServer('get_data', pythonArgs, question, course, (err, ret_data, ret_consoleLog) => {
            if (err) {
                consoleLog += _.get(err, ['data', 'outputBoth'], '');
                consoleLog += '\n';
                consoleLog += path.join(question_dir, 'server.py') + ': Error calling get_data()\n';
                consoleLog += err.toString();
                return callback(null, data, false, consoleLog);
            }

            if (_.isString(ret_consoleLog)) consoleLog += ret_consoleLog;
            data = ret_data;
            const checkErr = module.exports.checkQuestionData(data, checkOptions);
            if (checkErr) {
                consoleLog += 'Invalid state after server.get_data(): ' + checkErr + '\n';
                return callback(null, data, false, consoleLog);
            }

            this.execTemplate('question.html', data, question, course, (err, html, $) => {
                if (ERR(err, callback)) return;

                let index = 0;
                async.eachSeries(elements.keys(), (elementName, callback) => {
                    async.eachSeries($(elementName).toArray(), (element, callback) => {
                        this.elementFunction('prepare', elementName, $, element, index, data, (err, ret_data, ret_consoleLog) => {
                            if (err) {
                                consoleLog += _.get(err, ['data', 'outputBoth'], '');
                                if (err.code) consoleLog += 'Error code: ' + err.code;
                                const elementFile = module.exports.getElementFilename(elementName);
                                consoleLog += '\n';
                                consoleLog += elementFile + ': Error calling prepare()\n';
                                consoleLog += err.toString();
                                return callback(new Error());
                            }

                            if (_.isString(ret_consoleLog)) consoleLog += ret_consoleLog;
                            data = ret_data;
                            const checkErr = module.exports.checkQuestionData(data, checkOptions);
                            if (checkErr) {
                                consoleLog += _.get(err, ['data', 'outputBoth'], '');
                                const elementFile = module.exports.getElementFilename(elementName);
                                consoleLog += '\n';
                                consoleLog += elementFile + ': Error after prepare()\n';
                                consoleLog += 'Invalid state after element number ' + index + ' ' + elementName + '.parse(): ' + checkErr;
                                return callback(new Error());
                            }

                            index++;
                            callback(null);
                        });
                    }, (err) => {
                        if (err) return callback(err);
                        callback(null);
                    });
                }, (err) => {
                    if (err) return callback(null, data, false, consoleLog);
                    data = {
                        params: data.params,
                        true_answer: data.correct_answers,
                    };
                    callback(null, data, true, consoleLog);
                });
            });
        });
    },

    getFile: function(filename, variant, question, course, callback) {
        callback(new Error('not implemented'));
    },

    renderFile: function(filename, panel, variant, question, submission, course, locals, callback) {
        let data = {
            params: _.get(variant, 'params', {}),
            correct_answers: _.get(variant, 'true_answer', {}),
            submitted_answers: submission ? _.get(submission, 'submitted_answer', {}) : {},
            parse_errors: submission ? _.get(submission, 'parse_errors', {}) : {},
            partial_scores: submission ? _.get(submission, 'partial_scores', {}) : {},
            score: submission ? _.get(submission, 'score', 0) : 0,
            feedback: submission ? _.get(submission, 'feedback', {}) : {},
            variant_seed: parseInt(variant.variant_seed, 36),
            options: _.get(variant, 'options', {}),
            raw_submitted_answers: submission ? _.get(submission, 'raw_submitted_answer', {}) : {},
            editable: !!locals.allowAnswerEditing,
            panel: panel,
        };
        data.options.client_files_question_url = locals.paths.clientFilesQuestion;
        let consoleLog = '';

        const checkOptions = {has_submission: true, has_grading: true, for_render: true};
        const checkErr = module.exports.checkQuestionData(data, checkOptions);
        if (checkErr) {
            const err = new Error('Invalid state before render: ' + checkErr);
            err.data = {data, submission, variant, question, course};
            return callback(err);
        }

        this.execTemplate(filename, data, question, course, (err, html, $) => {
            if (ERR(err, callback)) return;

            let index = 0;
            async.eachSeries(elements.keys(), (elementName, callback) => {
                async.eachSeries($(elementName).toArray(), (element, callback) => {
                    this.elementFunction('render', elementName, $, element, index, data, (err, elementHtml, ret_consoleLog) => {
                        if (ERR(err, callback)) return;
                        $(element).replaceWith(elementHtml);
                        if (_.isString(ret_consoleLog)) consoleLog += ret_consoleLog;
                        index++;
                        callback(null);
                    });
                }, (err) => {
                    if (ERR(err, callback)) return;
                    callback(null);
                });
            }, (err) => {
                if (ERR(err, callback)) return;
                callback(null, $.html(), consoleLog);
            });
        });
    },

    renderQuestion: function(variant, question, submission, course, locals, callback) {
        this.renderFile('question.html', 'question', variant, question, submission, course, locals, (err, html) => {
            if (ERR(err, callback)) return;
            callback(null, html);
        });
    },

    renderSubmission: function(variant, question, submission, course, locals, callback) {
        this.renderFile('question.html', 'submission', variant, question, submission, course, locals, (err, html) => {
            if (ERR(err, callback)) return;
            callback(null, html);
        });
    },

    renderTrueAnswer: function(variant, question, course, locals, callback) {
        this.renderFile('question.html', 'answer', variant, question, null, course, locals, (err, html) => {
            if (ERR(err, callback)) return;
            callback(null, html);
        });
    },

    parseSubmission: function(submission, variant, question, course, callback) {
        let data = {
            params: _.get(variant, 'params', {}),
            correct_answers: _.get(variant, 'true_answer', {}),
            submitted_answers: _.get(submission, 'submitted_answer', {}),
            parse_errors: _.get(submission, 'parse_errors', {}),
            variant_seed: parseInt(variant.variant_seed, 36),
            options: _.get(variant, 'options', {}),
            raw_submitted_answers: _.get(submission, 'raw_submitted_answer', {}),
        };
        var consoleLog = '';

        const checkOptions = {has_submission: true, has_grading: false, for_render: false};
        const checkErr = module.exports.checkQuestionData(data, checkOptions);
        if (checkErr) {
            const err = new Error('Invalid state before parse: ' + checkErr);
            err.data = {data, submission, variant, question, course};
            return callback(err);
        }

        this.execTemplate('question.html', data, question, course, (err, html, $) => {
            if (ERR(err, callback)) return;

            let index = 0;
            async.eachSeries(elements.keys(), (elementName, callback) => {
                async.eachSeries($(elementName).toArray(), (element, callback) => {
                    this.elementFunction('parse', elementName, $, element, index, data, (err, ret_data, ret_consoleLog) => {
                        if (ERR(err, callback)) return;
                        data = ret_data;
                        const checkErr = module.exports.checkQuestionData(data, checkOptions);
                        if (checkErr) {
                            const err = new Error('Invalid state after element ' + index + ' ' + elementName + '.parse(): ' + checkErr);
                            err.data = {data, submission, variant, question, course};
                            return callback(err);
                        }
                        if (_.isString(ret_consoleLog)) consoleLog += ret_consoleLog;
                        index++;
                        callback(null);
                    });
                }, (err) => {
                    if (ERR(err, callback)) return;
                    callback(null);
                });
            }, (err) => {
                if (ERR(err, callback)) return;

                let checkErr = module.exports.checkQuestionData(data, checkOptions);
                if (checkErr) {
                    const err = new Error('Invalid state before server.parse(): ' + checkErr);
                    err.data = {data, submission, variant, question, course};
                    return callback(err);
                }
                // FIXME: call server.parse()
                checkErr = module.exports.checkQuestionData(data, checkOptions);
                if (checkErr) {
                    const err = new Error('Invalid state after server.parse(): ' + checkErr);
                    err.data = {data, submission, variant, question, course};
                    return callback(err);
                }

                callback(null, data.submitted_answers, data.parse_errors, consoleLog);
            });
        });
    },

    gradeSubmission: function(submission, variant, question, course, callback) {
        let data = {
            params: variant.params,
            correct_answers: variant.true_answer,
            submitted_answers: submission.submitted_answer,
            parse_errors: submission.parse_errors,
            partial_scores: (submission.partial_scores == null) ? {} : submission.partial_scores,
            score: (submission.score == null) ? 0 : submission.score,
            feedback: (submission.feedback == null) ? {} : submission.feedback,
            variant_seed: parseInt(variant.variant_seed, 36),
            options: _.get(variant, 'options', {}),
            raw_submitted_answers: submission.raw_submitted_answer,
        };
        var consoleLog = '';

        const checkOptions = {has_submission: true, has_grading: true, for_render: false};
        const checkErr = module.exports.checkQuestionData(data, checkOptions);
        if (checkErr) {
            const err = new Error('Invalid state before grade: ' + checkErr);
            err.data = {data, submission, variant, question, course};
            return callback(err);
        }

        this.execTemplate('question.html', data, question, course, (err, html, $) => {
            if (ERR(err, callback)) return;

            let index = 0;
            async.eachSeries(elements.keys(), (elementName, callback) => {
                async.eachSeries($(elementName).toArray(), (element, callback) => {
                    this.elementFunction('grade', elementName, $, element, index, data, (err, ret_data, ret_consoleLog) => {
                        if (ERR(err, callback)) return;
                        data = ret_data;
                        const checkErr = module.exports.checkQuestionData(data, checkOptions);
                        if (checkErr) {
                            const err = new Error('Invalid state after element ' + index + ' ' + elementName + '.grade(): ' + checkErr);
                            err.data = {data, submission, variant, question, course};
                            return callback(err);
                        }
                        if (_.isString(ret_consoleLog)) consoleLog += ret_consoleLog;
                        index++;
                        callback(null);
                    });
                }, (err) => {
                    if (ERR(err, callback)) return;
                    callback(null);
                });
            }, (err) => {
                if (ERR(err, callback)) return;
                let total_weight = 0, total_weight_score = 0;
                _.each(data.partial_scores, value => {
                    const score = _.get(value, 'score', 0);
                    const weight = _.get(value, 'weight', 1);
                    total_weight += weight;
                    total_weight_score += weight * score;
                });
                data.score = total_weight_score / (total_weight == 0 ? 1 : total_weight);
                data.feedback = {};

                let checkErr = module.exports.checkQuestionData(data, checkOptions);
                if (checkErr) {
                    const err = new Error('Invalid state before server.grade(): ' + checkErr);
                    err.data = {data, submission, variant, question, course};
                    return callback(err);
                }
                // FIXME: call server.grade()
                checkErr = module.exports.checkQuestionData(data, checkOptions);
                if (checkErr) {
                    const err = new Error('Invalid state after server.grade(): ' + checkErr);
                    err.data = {data, submission, variant, question, course};
                    return callback(err);
                }

                data = {
                    params: data.params,
                    true_answer: data.correct_answers,
                    submitted_answer: data.submitted_answers,
                    parse_errors: data.parse_errors,
                    raw_submitted_answer: data.raw_submitted_answers,
                    partial_scores: data.partial_scores,
                    score: data.score,
                    feedback: data.feedback,
                };
                callback(null, data, consoleLog);
            });
        });
    },
};
