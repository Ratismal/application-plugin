import {Client, Message, TextableChannel} from 'eris';
import {types as CFTypes} from 'eris-command-framework';
import {inject, injectable} from 'inversify';
import {Connection, Repository} from 'typeorm';
import {Logger} from 'winston';

import Application, {ApprovalType} from '../Entity/Application';
import {Config} from '../index';
import ApplicationService from '../Service/ApplicationService';
import Types from '../types';

@injectable()
export default class ApplicationVoteListener {
    private repo: Repository<Application>;

    private voteChannel: TextableChannel;

    public constructor(
        @inject(CFTypes.connection) connection: Connection,
        @inject(CFTypes.logger) private logger: Logger,
        @inject(Types.application.service.application) private appService: ApplicationService,
        @inject(CFTypes.discordClient) private client: Client,
        @inject(Types.application.config) private config: Config,
    ) {
        this.repo = connection.getRepository(Application);
        client.on('messageReactionAdd', this.onMessageReactionAdd.bind(this));
    }

    public async initialize(): Promise<void> {
        this.client.on('ready', async () => {
            if (!this.config.voteChannel) {
                throw new Error('Vote channel not set!');
            }
            this.voteChannel = await this.client.getChannel(this.config.voteChannel) as TextableChannel;
            if (!this.voteChannel) {
                throw new Error('Vote channel not found!');
            }

            await this.loadMessages();
        });
    }

    private async onMessageReactionAdd(
        voteMessage: Message,
        _emoji: { id: string, name: string },
        userId: string,
    ): Promise<void> {
        voteMessage = await this.client.getMessage(voteMessage.channel.id, voteMessage.id);
        if (!voteMessage.channel || voteMessage.channel.id !== this.voteChannel.id) {
            return;
        }

        if (userId === this.client.user.id) {
            return;
        }

        const voteMessageId = voteMessage.channel.id + ':' + voteMessage.id;
        const application   = await this.repo.findOne({voteMessageId});
        if (!application) {
            this.logger.warn(
                'Approval - Reaction: Found a message without an application, deleting: %j',
                {id: voteMessage.id, content: voteMessage.content, embeds: voteMessage.embeds[0].title},
            );
            await voteMessage.delete('Not an application');

            return;
        }

        await this.updateApplication(voteMessage, application);
    }

    private async loadMessages(): Promise<void> {
        this.logger.info('Loading application vote messages!');

        const applications: Application[] = await this.repo.find();
        for (const application of applications) {
            if (application.voteApproved === ApprovalType.AWAITING) {
                continue;
            }

            try {
                const [channelId, messageId] = application.voteMessageId.split(':');
                const message: Message       = await this.client.getMessage(channelId, messageId);
                if (null === message) {
                    throw new Error('Message not found');
                }

                await this.updateApplication(message, application);
            } catch (e) {
                this.logger.warn(
                    'Vote - Load: Found an application without a message, creating message: %j',
                    application,
                );
                const message = await this.appService.postApplicationMessage(application, false);

                application.voteMessageId = message.channel.id + ':' + message.id;
                await application.save();
            }
        }
    }

    private async updateApplication(
        message: Message,
        application: Application,
    ): Promise<void> {
        const reactions    = message.reactions;
        const {votePassed} = application;
        const reactionKeys = Object.keys(reactions);
        const passEmote    = votePassed === ApprovalType.APPROVED ? '✅' : '❌';

        if (votePassed === ApprovalType.AWAITING) {
            if (reactionKeys.length === 0) {
                try {
                    await message.addReaction('✅');
                    await message.addReaction('❌');
                } catch (err) {
                    this.logger.error('An issue has occurred while trying to add initial vote reactions: %O', err);

                    return;
                }
            }

            const votes     = await this.appService.getVotes(message, true);
            votes.entries   = {...application.votes.entries, ...votes.entries};
            votes.approvals = 0;
            votes.denies    = 0;

            application.votes = votes;
            await application.save();

            const embed        = message.embeds[0];
            const currentVotes = await this.appService.countVotes(application);

            if (!embed.fields[2]) {
                embed.fields[2] = {name: 'Votes', inline: true};
            }

            embed.fields[2].value = Object.keys(currentVotes.entries).length.toString();

            try {
                await message.edit({embed});
            } catch (e) {
                this.logger.error(e);
            }
        } else if (!reactions['👌']) {
            this.logger.warn(
                'Vote - Load: Found an expired application without result reactions, adding them: %j',
                application,
            );

            await message.removeReactions();
            await message.addReaction('👌');
            await message.addReaction(passEmote);
        } else {
            try {
                await this.removeExcessReactions('👌', message);
                await this.removeExcessReactions(passEmote, message);
            } catch (err) {
                this.logger.error('An issue occurred while checking and removing excess reactions: %O', err);
            }
        }
    }

    private async removeExcessReactions(emote: string, message: Message) {
        const reactionCounts = message.reactions;

        if (reactionCounts[emote].count > 1) {
            const allReactions = await this.client.getMessageReaction(message.channel.id, message.id, emote);
            const toRemove     = allReactions.filter((user) => user.id !== this.client.user.id);

            toRemove.forEach(async (member) => {
                await message.removeReaction(emote, member.id);
            });
        }
    }
}
