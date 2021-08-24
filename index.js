const
    express = require('express'),
    rp = require('request-promise'),
    bodyParser = require('body-parser'),
    dialogflow = require('dialogflow'),
    uuid = require('uuid');

const { Sequelize } = require('sequelize');
const Op = Sequelize.Op;

const app = express().use(bodyParser.json());

function addMinutes(date, minutes) {
    let result = new Date(date);
    result.setTime(result.getTime() + (minutes * 60 * 1000));
    return result;
}
function addHours(date, hours) {
    return addMinutes(date, hours * 60);
}
function addDays(date, days) {
    let result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
}
function addWeeks(date, weeks) {
    return addDays(date, days * 7);
}
function addMonths(date, months) {
    let result = new Date(date)
    let d = date.getDate();
    result.setMonth(result.getMonth() + months);
    if (result.getDate() != d) {
      result.setDate(0);
    }
    return result;
}
function addYears(date, years) {
    return addMonths(date, years * 12);
}
function addToDate(date, amount, unit) {
    if (unit === 'hours') {
        return addHours(date, amount);
    } else if (unit === 'minutes') {
        return addMinutes(date, amount);
    } else if (unit === 'weeks') {
        return addWeeks(date, amount);
    } else if (unit === 'months') {
        return addMonths(date, amount);
    } else if (unit === 'years') {
        return addYears(date, amount);
    }
    return addDays(date, amount);
}

const DBURI = process.env.DATABASE_URL;
const PROJECTID = 'project-id';

const sequelize = new Sequelize(DBURI, { define: { timestamps: false } });
sequelize
    .authenticate()
    .then(() => {
        console.log('Connection has been established successfully.');
    })
    .catch(err => {
        console.error('Unable to connect to the database:', err);
    });

const Reminder = sequelize.define('Reminder', {
    psid: {
        type: Sequelize.STRING,
        allowNull: false
    },
    medicinename: {
        type: Sequelize.STRING,
        allowNull: false
    },
    time: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: sequelize.literal('CURRENT_TIMESTAMP')
    },
    nextreminder: {
        type: Sequelize.DATE,
        allowNull: false
    },
    period: {
        type: Sequelize.FLOAT,
        allowNull: false,
        default: 1
    },
    unit: {
        type: Sequelize.STRING,
        allowNull: false,
        default: 'days'
    }
}, {
    tableName: 'reminders'
});

const Session = sequelize.define('Session', {
    sessionid: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true
    },
    psid: {
        type: Sequelize.STRING,
        allowNull: false
    },
    medicinename: {
        type: Sequelize.STRING
    },
    createdat: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: sequelize.literal('CURRENT_TIMESTAMP')
    },
    time: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: sequelize.literal('CURRENT_TIMESTAMP')
    },
    period: {
        type: Sequelize.FLOAT,
        default: 1
    },
    unit: {
        type: Sequelize.STRING,
        default: 'days'
    }
}, {
    tableName: 'sessions'
});

setInterval(async () => {
    try {
        const currentDate = new Date();
        const reminders = await Reminder.findAll({
            where: {
                nextreminder: {
                    [Op.lte]: currentDate
                }
            }
        });

        for (let reminder of reminders) {
            let nextReminder = addToDate(currentDate, reminder.dataValues.period, reminder.dataValues.unit);
            Reminder.update({
                nextreminder: nextReminder
            }, { where: { id: reminder.dataValues.id } })

            let splits = nextReminder.toString().split(' ').slice(0, 5);
            splits[4] = splits[4].slice(0, -3);
            let dateString = splits.join(' ');
            callSendAPI(reminder.dataValues.psid, {
                text: `Remember to take ${reminder.dataValues.medicinename} now. Your next reminder to take ${reminder.dataValues.medicinename} will be on ${dateString} UTC.`
            });
        }
    } catch (error) {
        console.error('An error occurred while finding or sending reminders:', err);
    }
}, 5 * 1000);

setInterval(() => {
    const currentDate = new Date();
    Session.destroy({
        where: {
            createdat: {
                [Op.lte]: new Date(currentDate - 60 * 60 * 1000)
            }
        }
    });
}, 60 * 60 * 1000);

app.listen(process.env.PORT || 1337, () => console.log('webhook is listening'));

app.post('/webhook', (req, res) => {

    let body = req.body;

    if (body.object === 'page') {
        body.entry.forEach(function(entry) {
            let webhook_event = entry.messaging[0];
            console.log(webhook_event);

            let sender_psid = webhook_event.sender.id;
            console.log(`Sender PSID: ${sender_psid}`);
            if (webhook_event.message) {
                handleMessage(sender_psid, webhook_event.message);
            }
        });
        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }

});

app.get('/webhook', (req, res) => {
    const VERIFY_TOKEN = "verify token"

    let mode = req.query['hub.mode'];
    let token = req.query['hub.verify_token'];
    let challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

async function runSample(queryText, sessionId) {
    const sessionClient = new dialogflow.SessionsClient({"keyFilename": "path to key file"});
    const sessionPath = sessionClient.sessionPath(PROJECTID, sessionId);

    const request = {
        session: sessionPath,
        queryInput: {
            text: {
                text: queryText,
                languageCode: 'en-US',
            },
        },
    };

    const responses = await sessionClient.detectIntent(request);
    console.log('Detected intent');
    const result = responses[0].queryResult;
    console.log(`  Query: ${result.queryText}`);
    console.log(`  Response: ${result.fulfillmentText}`);
    if (result.intent) {
        if (result.intent.displayName === 'Set Medicine Reminder') {
            if (result.parameters.fields.number.kind === 'numberValue') {
                result.parameters.fields.number.numberValue = result.parameters.fields.number.numberValue.toFixed(2);
            }
        }

        result.parameters.fields.intent = result.intent.displayName;
        result.parameters.fields.response = result.fulfillmentText;
        return result.parameters.fields;
    } else {
        return { intent: '' };
    }
}

async function handleMessage(sender_psid, received_message) {

    let sessionUUID;
    let session;

    const sessions = await Session.findAll({
        where: {
            psid: sender_psid
        },
        order: [
            [ 'createdat', 'DESC' ]
        ]
    });
    if (sessions.length === 0) {
        sessionUUID = uuid.v4();
        session = await Session.create({
            sessionid: sessionUUID,
            psid: sender_psid
        }).catch(err => {
            console.error('An error occurred while creating the session:', error);
        });
    } else {
        sessionUUID = sessions[0].dataValues.sessionid;
        session = sessions[0];
    }

    let response;

    if (received_message.text) {

        const params = await runSample(received_message.text, sessionUUID);

        if (params.intent === 'Set Medicine Reminder - yes'
                || params.intent === 'Set Medicine Reminder - Time - yes') {
            let medicineName = session.dataValues.medicinename;
            let period = session.dataValues.period;
            let unit = session.dataValues.unit;
            let timeString = session.dataValues.time;
            let time = new Date(timeString);
            let nextReminder = (time <= new Date()) ? addToDate(time, period, unit) : time;

            try {
                await Reminder.create({
                    psid: sender_psid,
                    medicinename: medicineName,
                    time: timeString,
                    nextreminder: nextReminder,
                    period: period,
                    unit: unit
                });
            } catch (error) {
                console.error('An error occurred while creating the reminder:', error);
                params.response = 'Sorry, but something went wrong. Please try again.'
            } finally {
                session.destroy();
            }
        } else if (params.intent === 'Set Medicine Reminder') {
            try {
                session.medicinename = params.medicine.stringValue;
                session.period = +params.number.numberValue || 1;
                session.unit = params.timefrequency.stringValue;
                await session.save();
            } catch (error) {
                console.error('An error occurred while updating the session:', error);
                params.response = 'Sorry, but something went wrong. Please try again.';
            }
        } else if (params.intent === 'Set Medicine Reminder - Time') {
            try {
                session.medicinename = params.medicine.stringValue;
                session.time = params.time.stringValue;
                await session.save();
            } catch (error) {
                console.error('An error occurred while updating the session:', error);
                params.response = 'Sorry, but something went wrong. Please try again.';
            }
        } else if (params.intent === 'Delete Medicine Reminder') {
            try {
                session.medicinename = params.medicine.stringValue;
                await session.save();
            } catch (error) {
                console.error('An error occurred while updating the session:', error);
                params.response = 'Sorry, but something went wrong. Please try again.';
            }
        } else if (params.intent === 'Delete Medicine Reminder - yes') {
            try {
                let medicineName = session.dataValues.medicinename;
                await Reminder.destroy({
                    where: {
                        [Op.and]: [{ psid: sender_psid }, { medicinename: medicineName }]
                    }
                });
            } catch (error) {
                console.error('An error occurred while deleting the reminder:', error);
                params.response = 'Sorry, but something went wrong. Please try again.';
            } finally {
                session.destroy();
            }
        } else {
            session.destroy();
        }

        response = { "text": params.response };
    }

    callSendAPI(sender_psid, response);
}

function callSendAPI(sender_psid, response) {
    const PAGE_ACCESS_TOKEN = "Insert page access token here"

    let request_body = {
        "recipient": {
            "id": sender_psid
        },
        "message": response
    }

    rp({
        "uri": "facebook resource uri",
        "qs": { "access_token": PAGE_ACCESS_TOKEN },
        "method": "POST",
        "json": request_body
    }, (err, res, body) => {
        if (!err) {
            console.log('message sent!')
        } else {
            console.error("Unable to send message:" + err);
        }
    });
}
