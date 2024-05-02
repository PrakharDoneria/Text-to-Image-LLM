import { Telegraf } from 'telegraf';
import fetch from 'node-fetch';
import { promises as fsPromises } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import express from 'express';
import { randomBytes } from 'crypto';
import { client } from "@gradio/client";
import axios from 'axios';
import FormData from 'form-data';

dotenv.config();

function handleError(error) {
    console.error(error);
}

try {
    const mongoURI = process.env.MONGODB_URI;
    mongoose.connect(mongoURI);
    const db = mongoose.connection;
    db.on("error", (error) => {
        console.error("MongoDB connection error:", error);
        handleError(error);
    });
    db.once("open", () => {
        console.log("Connected to MongoDB");
    });
} catch (error) {
    console.error("Error connecting to MongoDB:", error);
    handleError(error);
}

const usernameSchema = new mongoose.Schema({
    username: { type: String, unique: true }
});
const Username = mongoose.model('Username', usernameSchema);

const imageSchema = new mongoose.Schema({
    username: String,
    date: { type: String, default: () => new Date().toISOString().split('T')[0] },
    count: { type: Number, default: 0 },
    expireAt: { type: Date, default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) }
});
imageSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
const Image = mongoose.model('Image', imageSchema);

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const app = express();

app.get('/', (req, res) => {
    res.send('Server is up and running!');
});

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something went wrong!');
});

async function asyncMiddleware(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch((error) => {
            handleError(error);
            next(error);
        });
    };
}

async function query(data) {
    try {
        const response = await fetch(
            "https://api-inference.huggingface.co/models/cagliostrolab/animagine-xl-3.1",
            {
                headers: { Authorization: `Bearer ${process.env.HUGGING_FACE_API_KEY}`, "Content-Type": "application/json" },
                method: "POST",
                body: JSON.stringify(data),
            }
        );

        if (!response.ok) {
            throw new Error(`Failed to fetch data from Hugging Face API: ${response.status} - ${response.statusText}`);
        }

        const result = await response.blob();
        return result;
    } catch (error) {
        throw new Error(`Error fetching data from Hugging Face API: ${error.message}`);
    }
}

async function uploadToImgBB(imageBlob) {
    try {
        const formData = new FormData();
        formData.append('image', imageBlob, 'image.jpg');
        formData.append('expiration', 'never');

        const response = await axios.post('https://api.imgbb.com/1/upload', formData, {
            headers: {
                'Content-Type': 'multipart/form-data'
            },
            params: {
                key: process.env.IMGBB_API_KEY
            }
        });

        if (!response.data || !response.data.data || !response.data.data.url) {
            throw new Error("Failed to upload image to imgBB.");
        }

        return response.data.data.url;
    } catch (error) {
        throw new Error(`Error uploading image to imgBB: ${error.message}`);
    }
}

bot.command('anime', async (ctx) => {
    try {
        const prompt = ctx.message.text.split(' ').slice(1).join(' ');
        if (!prompt) {
            ctx.reply('Please provide a prompt.');
            return;
        }

        const imageBlob = await query({ prompt });
        const imageUrl = await uploadToImgBB(imageBlob);

        await ctx.replyWithPhoto({ url: imageUrl });
    } catch (error) {
        console.error("Error:", error.message);
        ctx.reply('Internal Server Error');
    }
});

bot.command('myData', async (ctx) => {
    try {
        const username = ctx.from.username;
        if (!username) {
            ctx.reply('You need to set a username to use this command.');
            return;
        }

        const { count, expireAt } = await getImageCount(username);
        const lastImageTime = expireAt ? expireAt.toLocaleTimeString() : 'N/A';

        const userData = `================\nUsername: ${username}\nTotal images (today): ${count}\nLast image: ${lastImageTime}\n================\n`;

        await ctx.reply(userData);
    } catch (error) {
        handleError(error);
        ctx.reply('An error occurred while fetching your data.');
    }
});

bot.command('showDB', async (ctx) => {
    try {
        const users = await Username.find({});
        let replyMessage = '';

        if (users.length === 0) {
            ctx.reply('No users found.');
            return;
        }

        for (const user of users) {
            const { username } = user;
            const { count, expireAt } = await getImageCount(username);
            const lastImageTime = expireAt ? expireAt.toLocaleTimeString() : 'N/A';

            const userData = `================\nUsername: ${username}\nTotal images (today): ${count}\nLast image: ${lastImageTime}\n================\n`;

            replyMessage += userData;
        }

        await ctx.reply(replyMessage);
    } catch (error) {
        handleError(error);
        ctx.reply('An error occurred while fetching user data.');
    }
});

bot.command('imagine', async (ctx) => {
    try {
        const prompt = ctx.message.text.replace('/imagine', '').trim();
        if (!prompt) {
            ctx.reply('Please provide a prompt.');
            return;
        }

        const username = ctx.from.username;
        if (!username) {
            ctx.reply('You need to set a username to use this command.');
            return;
        }

        const isUsernameInDatabase = await checkUsernameInDatabase(username);
        const { count, expireAt } = await getImageCount(username);
        if (!isUsernameInDatabase && count >= 3 && new Date(expireAt) > new Date()) {
            const remainingTime = Math.ceil((new Date(expireAt) - new Date()) / (1000 * 60 * 60));
            ctx.reply(`You have reached the limit of 3 images per day. Please try again after ${remainingTime} hours, Or send /donate to continue using the Bot.`);
            return;
        }

        const message = await ctx.reply('Making the magic happen...');

        const imageFilePath = await getProLLMResponse(prompt);
        await ctx.telegram.sendChatAction(ctx.chat.id, 'upload_photo');

        await ctx.replyWithPhoto({ source: await fsPromises.readFile(imageFilePath) }, {
            caption: "Download Android app:\n\tGalaxy Store : https://galaxy.store/llm \n\tOR\n\t Uptodown : https://verbovisions-free-ai-image-maker.en.uptodown.com/android)\nTry the web version:\n\tWebsite : https://verbo-visions-web.vercel.app/"
        });

        await ctx.telegram.deleteMessage(ctx.chat.id, message.message_id);
        await saveImageCount(username);
    } catch (error) {
        handleError(error);
        const errorMessage = `An error occurred while processing your request:\n\`\`\`javascript\n${error}\n\`\`\``;
        ctx.reply(errorMessage);
    }
});

bot.command('donate', async (ctx) => {
    try {
        await ctx.reply('Support us by donating at: https://html-editor-pro.vercel.app/donations/');
    } catch (error) {
        handleError(error);
    }
});

bot.command('add', async (ctx) => {
    try {
        if (ctx.from.username !== 'PrakharDoneria') {
            ctx.reply('Sorry, only @prakhardoneria is allowed to use this command.');
            return;
        }

        const username = ctx.message.text.split(' ')[1];
        if (!username) {
            ctx.reply('Please provide a username.');
            return;
        }

        const existingUser = await Username.findOne({ username });
        if (existingUser) {
            ctx.reply('Username already exists.');
            return;
        }

        await Username.create({ username });
        ctx.reply(`Username ${username} added successfully.`);
    } catch (error) {
        handleError(error);
        ctx.reply('An error occurred while adding the username.');
    }
});

bot.command('id', (ctx) => {
    try {
        const username = ctx.from.username;
        if (username) {
            ctx.reply(`Your username is: @${username}`);
        } else {
            ctx.reply('You do not have a username set.');
        }
    } catch (error) {
        handleError(error);
    }
});

bot.command('video', async (ctx) => {
    try {
        const username = ctx.from.username;
        if (!username) {
            ctx.reply('You need to set a username to use this command.');
            return;
        }

        const isUsernameInDatabase = await checkUsernameInDatabase(username);
        const { count, expireAt } = await getImageCount(username);
        if (!isUsernameInDatabase && count >= 3 && new Date(expireAt) > new Date()) {
            const remainingTime = Math.ceil((new Date(expireAt) - new Date()) / (1000 * 60 * 60));
            ctx.reply(`You have reached the limit of 3 images per day. Please try again after ${remainingTime} hours, Or send /donate to continue using the Bot.`);
            return;
        }

        const message = await ctx.reply('Making the video...');

        const uploadedImage = ctx.message.photo[0].file_id;
        const app = await client("doevent/AnimateLCM-SVD");
        const result = await app.predict("/video", [
            uploadedImage,
            0,
            true,
            1,
            5,
            1,
            1.5,
            576,
            320,
            20,
        ]);

        const videoFilePath = result.data;
        await ctx.telegram.sendChatAction(ctx.chat.id, 'upload_video');
        await ctx.replyWithVideo({ source: videoFilePath }, { caption: "Generated video" });

        await ctx.telegram.deleteMessage(ctx.chat.id, message.message_id);
        await saveImageCount(username);
    } catch (error) {
        handleError(error);
        const errorMessage = `An error occurred while processing your request:\n\`\`\`javascript\n${error}\n\`\`\``;
        ctx.reply(errorMessage);
    }
});

bot.command('version', async (ctx) => {
    try {
        await ctx.reply('v2 Alpha');
    } catch (error) {
        console.error("Error:", error.message);
        ctx.reply('Internal Server Error');
    }
});

bot.on('message_delete', async (ctx) => {
    try {
        const deletedMessage = ctx.update.message;
        if (deletedMessage && deletedMessage.text === 'message_deleted') {
            await ctx.reply(`Download Android app: https://galaxy.store/llm
                            OR
                            https://verbovisions-free-ai-image-maker.en.uptodown.com/android
                            Try the web version: https://verbo-visions-web.vercel.app/`);
        }
    } catch (error) {
        handleError(error);
    }
});

bot.on('message', async (ctx) => {
    try {
        if (ctx.message.text === 'message_deleted') {
            await ctx.reply(`Download Android app: https://galaxy.store/llm
                            OR
                            https://verbovisions-free-ai-image-maker.en.uptodown.com/android
                            Try the web version: https://verbo-visions-web.vercel.app/`);
        }
    } catch (error) {
        handleError(error);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

try {
    bot.launch();
} catch (error) {
    if (error.description && error.description.includes('Forbidden: bot was blocked by the user')) {
        console.log('Bot was blocked by the user. Ignoring.');
    } else {
        console.error(error);
        handleError(error);
    }
}
