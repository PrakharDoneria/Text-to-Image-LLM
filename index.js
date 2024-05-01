import { Telegraf } from 'telegraf';
import fetch from 'node-fetch';
import { promises as fsPromises } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import express from 'express';
import { randomBytes } from 'crypto';

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
    res.send('Jinda hu');
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

async function getProLLMResponse(prompt) {
    try {
        const seedBytes = randomBytes(4);
        const seed = seedBytes.readUInt32BE();
        const data = {
            width: 1024,
            height: 1024,
            seed: seed,
            num_images: 1,
            modelType: process.env.MODEL_TYPE,
            sampler: 9,
            cfg_scale: 3,
            guidance_scale: 3,
            strength: 1.7,
            steps: 30,
            high_noise_frac: 1,
            negativePrompt: 'ugly, deformed, noisy, blurry, distorted, out of focus, bad anatomy, extra limbs, poorly drawn face, poorly drawn hands, missing fingers',
            prompt: prompt,
            hide: false,
            isPrivate: false,
            batchId: '0yU1CQbVkr',
            generateVariants: false,
            initImageFromPlayground: false,
            statusUUID: '8c057d08-00f7-4ad6-903e-e10a2bb81d07'
        };
        const response = await fetch(process.env.BACKEND_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Cookie': process.env.COOKIES
            },
            body: JSON.stringify(data)
        });
        const json = await response.json();
        const imageUrl = `https://images.playground.com/${json.images[0].imageKey}.jpeg`;
        const imageResponse = await fetch(imageUrl);
        const buffer = Buffer.from(await imageResponse.arrayBuffer());

        const tempFilePath = join(tmpdir(), `${Date.now()}.jpeg`);
        await fsPromises.writeFile(tempFilePath, buffer);
        return tempFilePath;
    } catch (error) {
        handleError(error);
        throw error;
    }
}

async function checkUsernameInDatabase(username) {
    try {
        const user = await Username.findOne({ username });
        return !!user;
    } catch (error) {
        handleError(error);
        return false;
    }
}

async function getImageCount(username) {
    try {
        const today = new Date().toISOString().split('T')[0];
        const image = await Image.findOne({ username, date: today });
        return image ? { count: image.count, expireAt: image.expireAt } : { count: 0, expireAt: null };
    } catch (error) {
        handleError(error);
        return { count: 0, expireAt: null };
    }
}

async function saveImageCount(username) {
    try {
        const today = new Date().toISOString().split('T')[0];
        await Image.findOneAndUpdate({ username, date: today }, { $inc: { count: 1 } }, { upsert: true });
    } catch (error) {
        handleError(error);
    }
}

bot.command('myData', async (ctx) => {
    try {
        const username = ctx.from.username; // Get the username of the user who sent the command
        if (!username) {
            ctx.reply('You need to set a username to use this command.');
            return;
        }

        const { count, expireAt } = await getImageCount(username); // Get image count and expiration time for the current user
        const lastImageTime = expireAt ? expireAt.toLocaleTimeString() : 'N/A';

        // Format user data
        const userData = `================\nUsername: ${username}\nTotal images (today): ${count}\nLast image: ${lastImageTime}\n================\n`;

        // Reply with the formatted user data
        await ctx.reply(userData);
    } catch (error) {
        handleError(error);
        ctx.reply('An error occurred while fetching your data.');
    }
});


bot.command('showDB', async (ctx) => {
    try {
        const users = await Username.find({}); // Fetch all users
        let replyMessage = ''; // Initialize the reply message

        // Iterate through each user
        for (const user of users) {
            const { username } = user;
            const { count, expireAt } = await getImageCount(username); // Get image count and expiration time
            const lastImageTime = expireAt ? expireAt.toLocaleTimeString() : 'N/A';

            // Format user data
            const userData = `================\nUsername: ${username}\nTotal images (today): ${count}\nLast image: ${lastImageTime}\n================\n`;

            replyMessage += userData; // Append user data to the reply message
        }

        // Reply with the formatted user data as a single message
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
            const remainingTime = Math.ceil((new Date(expireAt) - new Date()) / (1000 * 60 * 60)); // Convert milliseconds to hours
            ctx.reply(`You have reached the limit of 3 images per day. Please try again after ${remainingTime} hours, Or send /donate to continue using the Bot.`);
            return;
        }

        const message = await ctx.reply('Making the magic happen...');

        const imageFilePath = await getProLLMResponse(prompt);
        await ctx.telegram.sendChatAction(ctx.chat.id, 'upload_photo');

        // Adding caption after sending the image
        await ctx.replyWithPhoto({ source: await fsPromises.readFile(imageFilePath) }, {
            caption: "Download Android app:\n\tGalaxy Store : https://galaxy.store/llm \n\tOR\n\t Uptodown : https://verbovisions-free-ai-image-maker.en.uptodown.com/android)\nTry the web version:\n\tWebsite : https://verbo-visions-web.vercel.app/"
        });

        await ctx.telegram.deleteMessage(ctx.chat.id, message.message_id);
        await saveImageCount(username);

        // Adding caption after sending the image
        //await ctx.reply(`Download Android app:\n\tGalaxy Store : https://galaxy.store/llm \n\tOR\n\t Uptodown : https://verbovisions-free-ai-image-maker.en.uptodown.com/android)\nTry the web version:\n\tWebsite : https://verbo-visions-web.vercel.app/`);
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

bot.on('message', async (ctx) => {
    try {
        if (ctx.message.text === 'message_deleted') {
            // Resend the message
            await ctx.reply(`Download Android app: https://galaxy.store/llm
                            OR
                            https://verbovisions-free-ai-image-maker.en.uptodown.com/android
                            Try the web version: https://verbo-visions-web.vercel.app/`);
        }
    } catch (error) {
        handleError(error);
    }
});

bot.on('message_delete', async (ctx) => {
    try {
        const deletedMessage = ctx.update.message;
        if (deletedMessage && deletedMessage.text === 'message_deleted') {
            // Resend the message
            await ctx.reply(`Download Android app: https://galaxy.store/llm
                            OR
                            https://verbovisions-free-ai-image-maker.en.uptodown.com/android
                            Try the web version: https://verbo-visions-web.vercel.app/`);
        }
    } catch (error) {
        handleError(error);
    }
});

bot.on('inlineQuery', async (ctx) => {
    try {
        const prompt = ctx.inlineQuery.query.trim();
        if (!prompt) {
            return;
        }

        const imageFilePath = await getProLLMResponse(prompt);
        const caption = "Download Android app:\n\tGalaxy Store : https://galaxy.store/llm \n\tOR\n\t Uptodown : https://verbovisions-free-ai-image-maker.en.uptodown.com/android)\nTry the web version:\n\tWebsite : https://verbo-visions-web.vercel.app/";

        // Respond with the generated image
        await ctx.telegram.sendPhoto(ctx.inlineQuery.from.id, { source: await fsPromises.readFile(imageFilePath) }, {
            caption: caption,
            reply_markup: { inline_keyboard: [[{ text: "Download Android app", url: "https://galaxy.store/llm" }], [{ text: "Uptodown", url: "https://verbovisions-free-ai-image-maker.en.uptodown.com/android" }], [{ text: "Website", url: "https://verbo-visions-web.vercel.app/" }]] }
        });
    } catch (error) {
        handleError(error);
    }
});


const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

try {
    bot.launch();
} catch (error) {
    if (error.description && error.description.includes('Forbidden: bot was blocked by the user')) {
        
        console.log('Bot was blocked by the user. Ignoring.');
    } else {
        // Handle other errors
        console.error(error);
        handleError(error);
    }
}
